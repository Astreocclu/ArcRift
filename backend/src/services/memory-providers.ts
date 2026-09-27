import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { MemoryBudget } from "./memory-budget";

const execFileAsync = promisify(execFile);
export const MIMO_MODEL = "xiaomi/mimo-v2.6-pro";
export const LUNA_MODEL = "openai-codex/gpt-6-luna";
export const SOL_MODEL = "openai-codex/gpt-6-sol";

export type HttpPost = (url: string, body: any, config: any) => Promise<{ data: any }>;
export type PiExecutor = (model: string, promptPath: string) => Promise<string>;

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

async function defaultExecPi(model: string, promptPath: string): Promise<string> {
  const result = await execFileAsync("/home/astre/bin/pi", [
    "--print", "--no-session", "--no-tools", "--no-context-files", "--no-extensions",
    "--no-skills", "--no-prompt-templates", "--model", model, "--thinking", "high",
    `@${promptPath}`, "Return only one JSON object matching the requested schema.",
  ], { maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

export class MemoryProviders {
  private readonly openRouterKey?: string;
  private readonly httpPost: HttpPost;
  private readonly execPi: PiExecutor;
  private readonly retries: number;
  private readonly budget?: MemoryBudget;

  constructor(options: {
    openRouterKey?: string;
    httpPost?: HttpPost;
    execPi?: PiExecutor;
    retries?: number;
    budget?: MemoryBudget;
  } = {}) {
    this.openRouterKey = options.openRouterKey ?? process.env.ARCRIFT_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
    this.httpPost = options.httpPost ?? ((url, body, config) => axios.post(url, body, config));
    this.execPi = options.execPi ?? defaultExecPi;
    this.retries = options.retries ?? 2;
    this.budget = options.budget;
  }

  async callMimo(prompt: string): Promise<{ value: any; cost: number; requestHash: string }> {
    if (!this.openRouterKey) throw new Error("An OpenRouter key is required for MiMo");
    if (this.budget && !this.budget.canStart(0.02)) throw new Error("budget_hold");
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const response = await this.httpPost("https://openrouter.ai/api/v1/chat/completions", {
          model: MIMO_MODEL,
          messages: [{ role: "user", content: prompt }],
          reasoning: { effort: "low" },
          response_format: { type: "json_object" },
        }, { headers: { Authorization: `Bearer ${this.openRouterKey}`, "Content-Type": "application/json" }, timeout: 60_000 });
        const content = response.data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("Invalid provider JSON: missing message content");
        const value = parseJson(content);
        const cost = Number(response.data?.usage?.cost ?? response.data?.usage?.cost_details?.upstream_inference_cost ?? 0);
        if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid provider cost");
        const requestHash = crypto.createHash("sha256").update(`${prompt}\0${content}`).digest("hex");
        this.budget?.record("openrouter", MIMO_MODEL, cost, requestHash);
        return { value, cost, requestHash };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  callLuna(prompt: string): Promise<any> { return this.callPi(LUNA_MODEL, prompt); }
  callSol(prompt: string): Promise<any> { return this.callPi(SOL_MODEL, prompt); }

  private async callPi(model: string, prompt: string): Promise<any> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-memory-prompt-"));
    const promptPath = path.join(dir, "prompt.txt");
    fs.writeFileSync(promptPath, prompt, { mode: 0o600 });
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try { return parseJson(await this.execPi(model, promptPath)); }
        catch (error) { lastError = error; }
      }
      throw lastError;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
