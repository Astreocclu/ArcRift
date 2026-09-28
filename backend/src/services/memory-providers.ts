import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { MemoryBudget } from "./memory-budget";
import { runPiProcess } from "./pi-executor";

export const MIMO_MODEL = "xiaomi/mimo-v2.6-pro";
export const LUNA_MODEL = "openai-codex/gpt-6-luna";
export const SOL_MODEL = "openai-codex/gpt-6-sol";
export const MIMO_MAX_TOKENS = 32_000;
// OpenRouter maps low reasoning effort to approximately 20% of max_tokens.
// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
export const MIMO_LOW_REASONING_SHARE = 0.2;
export const MIMO_REASONING_TOKEN_RESERVE = Math.ceil(MIMO_MAX_TOKENS * MIMO_LOW_REASONING_SHARE);
export const MIMO_MAX_DECISION_TOKENS = MIMO_MAX_TOKENS - MIMO_REASONING_TOKEN_RESERVE;
export const MIMO_MAX_INPUT_BYTES = 40_000;
export const MIMO_ATTEMPT_RESERVATION_USD = 0.06;
export const MIMO_WORST_CASE_USD = (MIMO_MAX_INPUT_BYTES * 0.5 + MIMO_MAX_TOKENS * 1) / 1_000_000;
export const DEFAULT_PI_TIMEOUT_MS = 26_000;

export type HttpPost = (url: string, body: any, config: any) => Promise<{ data: any }>;
export type PiExecutor = (model: string, promptPath: string, timeoutMs: number) => Promise<string>;

export function piProcessArgs(model: string, promptPath: string): string[] {
  return [
    "--print", "--no-session", "--no-tools", "--no-context-files", "--no-extensions",
    "--no-skills", "--no-prompt-templates", "--model", model, "--thinking", "high",
    `@${promptPath}`, "Return only one JSON object matching the requested schema.",
  ];
}

function parseJson(text: string): any {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be an object");
    return value;
  } catch (error) {
    throw new Error(`Invalid provider JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class MemoryProviderError extends Error {
  constructor(message: string, readonly rawReply?: string) {
    super(message);
    this.name = "MemoryProviderError";
  }
}

export async function defaultExecPi(model: string, promptPath: string, timeoutMs: number): Promise<string> {
  const result = await runPiProcess(piProcessArgs(model, promptPath), { timeoutMs });
  if (result.timedOut) throw new Error(`Pi provider timed out after ${timeoutMs}ms`);
  if (result.bufferExceeded) throw new Error("Pi provider exceeded the output limit");
  if (result.spawnError) throw new Error(`Pi provider failed to start: ${result.spawnError}`);
  if (result.exitCode !== 0) throw new Error(`Pi provider failed with exit ${String(result.exitCode)} signal ${String(result.signal)}: ${result.stderr.slice(-2_000)}`);
  return result.stdout;
}

export class MemoryProviders {
  private readonly openRouterKey?: string;
  private readonly httpPost: HttpPost;
  private readonly execPi: PiExecutor;
  private readonly retries: number;
  private readonly piRetries: number;
  private readonly piTimeoutMs: number;
  private readonly budget?: MemoryBudget;

  constructor(options: {
    openRouterKey?: string;
    httpPost?: HttpPost;
    execPi?: PiExecutor;
    retries?: number;
    piRetries?: number;
    piTimeoutMs?: number;
    budget?: MemoryBudget;
  } = {}) {
    this.openRouterKey = options.openRouterKey ?? process.env.ARCRIFT_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
    this.httpPost = options.httpPost ?? ((url, body, config) => axios.post(url, body, config));
    this.execPi = options.execPi ?? defaultExecPi;
    this.retries = options.retries ?? 2;
    this.piRetries = options.piRetries ?? 0;
    this.piTimeoutMs = options.piTimeoutMs ?? DEFAULT_PI_TIMEOUT_MS;
    this.budget = options.budget;
  }

  async callMimo(prompt: string): Promise<{ value: any; cost: number; requestHash: string; rawReply: string }> {
    if (!this.openRouterKey) throw new Error("An OpenRouter key is required for MiMo");
    if (Buffer.byteLength(prompt, "utf8") > MIMO_MAX_INPUT_BYTES) throw new Error("MiMo prompt exceeds the budgeted input limit");
    let lastError: unknown;
    let lastRawReply: string | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const reservationId = crypto.randomUUID();
      if (this.budget && !this.budget.reserve(reservationId, "openrouter", MIMO_MODEL, MIMO_ATTEMPT_RESERVATION_USD)) throw new Error("budget_hold");
      try {
        const response = await this.httpPost("https://openrouter.ai/api/v1/chat/completions", {
          model: MIMO_MODEL,
          messages: [{ role: "user", content: prompt }],
          reasoning: { effort: "low" },
          response_format: { type: "json_object" },
          max_tokens: MIMO_MAX_TOKENS,
          provider: { allow_fallbacks: false, max_price: { prompt: 0.5, completion: 1 } },
        }, { headers: { Authorization: `Bearer ${this.openRouterKey}`, "Content-Type": "application/json" }, timeout: 60_000 });
        const content = response.data?.choices?.[0]?.message?.content;
        const reportedCost = response.data?.usage?.cost ?? response.data?.usage?.cost_details?.upstream_inference_cost;
        const cost = Number(reportedCost);
        if (reportedCost == null) throw new Error("Missing provider cost");
        if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid provider cost");
        const requestHash = crypto.createHash("sha256").update(`${reservationId}\0${prompt}\0${String(content)}\0${attempt}`).digest("hex");
        this.budget?.settle(reservationId, cost, requestHash);
        if (typeof content !== "string") throw new Error("Invalid provider JSON: missing message content");
        lastRawReply = content;
        let value: any;
        try {
          value = parseJson(content);
        } catch (error) {
          throw new MemoryProviderError(error instanceof Error ? error.message : String(error), content);
        }
        return { value, cost, requestHash, rawReply: content };
      } catch (error) {
        this.budget?.forfeit(reservationId);
        lastError = error;
        if (error instanceof MemoryProviderError && error.rawReply !== undefined) lastRawReply = error.rawReply;
      }
    }
    if (lastError instanceof MemoryProviderError) throw lastError;
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw lastRawReply === undefined ? new Error(message) : new MemoryProviderError(message, lastRawReply);
  }

  callLuna(prompt: string): Promise<any> { return this.callPi(LUNA_MODEL, prompt); }
  callSol(prompt: string): Promise<any> { return this.callPi(SOL_MODEL, prompt); }

  private async callPi(model: string, prompt: string): Promise<any> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-memory-prompt-"));
    const promptPath = path.join(dir, "prompt.txt");
    fs.writeFileSync(promptPath, prompt, { mode: 0o600 });
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.piRetries; attempt++) {
        try {
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Pi provider timed out after ${this.piTimeoutMs}ms`)), this.piTimeoutMs);
          });
          try {
            return parseJson(await Promise.race([this.execPi(model, promptPath, this.piTimeoutMs), timeout]));
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        catch (error) { lastError = error; }
      }
      throw lastError;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
