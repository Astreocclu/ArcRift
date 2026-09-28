import crypto from "crypto";
import fs from "fs";
import path from "path";
import { LUNA_MODEL, piProcessArgs, SOL_MODEL } from "../services/memory-providers";
import { formatCt, runPiProcess } from "../services/pi-executor";

const MEASUREMENT_TIMEOUT_MS = 600_000;

export function gateLatencyPrompts(): Array<{ id: string; kind: "triage" | "supersession"; prompt: string }> {
  const sized = (sentence: string, bytes: number) => sentence.repeat(Math.ceil(bytes / sentence.length)).slice(0, bytes);
  const triage = (source: string, content: string) =>
    `Classify durable memory. Return JSON {label,scope,confidence,records:[{subject_key,text}]}. Source=${source}. Content:\n${content}`;
  const supersession = (oldText: string, newText: string) =>
    `Classify the relationship as same, newer, older, conflict, or unrelated. Return {"decision":"..."}.\nOLD: ${oldText}\nNEW: ${newText}\nSIMILARITY: 0.91`;
  return [
    {
      id: "triage-decision",
      kind: "triage",
      prompt: triage("agent-zero", sized("The release decision remains agent-owned after verification. ", 1_024)),
    },
    {
      id: "triage-preference",
      kind: "triage",
      prompt: triage("agent-zero", sized("The user prefers concise progress updates during long-running checks. ", 4_096)),
    },
    {
      id: "triage-receipt",
      kind: "triage",
      prompt: triage("claude", sized("The backend verification passed and the production integrity check returned ok. ", 8_192)),
    },
    {
      id: "supersession-newer",
      kind: "supersession",
      prompt: supersession(
        sized("The measured release timeout is 12000 milliseconds. ", 8_192),
        sized("The measured release timeout is 45000 milliseconds. ", 8_192),
      ),
    },
    {
      id: "supersession-conflict",
      kind: "triage",
      prompt: triage("agent-zero", sized("Kernel promotion requires two consecutive passing evaluations. ", 32_000)),
    },
  ];
}

export function recommendedPiTimeoutMs(durationsMs: number[]): number {
  if (durationsMs.length === 0 || durationsMs.some(value => !Number.isFinite(value) || value < 0)) throw new Error("valid observed durations are required");
  return Math.ceil((Math.max(...durationsMs) * 1.5) / 1_000) * 1_000;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stripCodeFence(stdout: string): string {
  return stdout.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseOut(args: string[]): string {
  const index = args.indexOf("--out");
  if (index < 0 || !args[index + 1]) throw new Error("Usage: --out FILE");
  return path.resolve(args[index + 1]);
}

async function main(): Promise<void> {
  const out = parseOut(process.argv.slice(2));
  const rawDir = `${out.replace(/\.json$/i, "")}.raw`;
  fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  const receipt: any = {
    schema_version: 1,
    started_at_ct: formatCt(),
    ended_at_ct: null,
    route: "pi-codex-subscription",
    settings: { thinking: "high", tools_enabled: false, provider_fallback: false, prompt_route: "mode-0600-file", timeout_ms: MEASUREMENT_TIMEOUT_MS },
    required_multiplier: 1.5,
    samples: [],
  };
  const durations: number[] = [];
  let failed = false;
  for (const model of [LUNA_MODEL, SOL_MODEL]) {
    for (const sample of gateLatencyPrompts()) {
      const stem = `${model.split("/").pop()}-${sample.id}`;
      const promptFile = path.resolve(rawDir, `${stem}.prompt.txt`);
      fs.writeFileSync(promptFile, sample.prompt, { mode: 0o600 });
      const result = await runPiProcess(piProcessArgs(model, promptFile), { timeoutMs: MEASUREMENT_TIMEOUT_MS });
      const rawFile = path.resolve(rawDir, `${stem}.stdout.txt`);
      fs.writeFileSync(rawFile, result.stdout, { mode: 0o600 });
      let validJson = false;
      let parseError: string | null = null;
      try {
        const parsed = JSON.parse(stripCodeFence(result.stdout));
        validJson = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
        if (!validJson) parseError = "root must be a JSON object";
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      const transportOk = result.exitCode === 0 && !result.signal && !result.timedOut && !result.spawnError && !result.bufferExceeded;
      const ok = transportOk && validJson;
      if (ok) durations.push(result.durationMs);
      else failed = true;
      receipt.samples.push({
        model,
        prompt_id: sample.id,
        prompt_kind: sample.kind,
        prompt_bytes: Buffer.byteLength(sample.prompt, "utf8"),
        prompt_file: promptFile,
        prompt_file_mode: (fs.statSync(promptFile).mode & 0o777).toString(8).padStart(4, "0"),
        prompt_sha256: sha256(sample.prompt),
        start_ct: result.startedAtCt,
        end_ct: result.endedAtCt,
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        signal: result.signal,
        timed_out: result.timedOut,
        stdin_closed: result.stdinClosed,
        stderr_tail: result.stderr.slice(-2_000),
        raw_stdout_file: rawFile,
        raw_stdout_sha256: sha256(result.stdout),
        valid_json: validJson,
        parse_error: parseError,
        ok,
      });
    }
  }
  receipt.observed_max_ms = durations.length ? Math.max(...durations) : null;
  receipt.recommended_pi_timeout_ms = failed ? null : recommendedPiTimeoutMs(durations);
  receipt.passed = !failed && receipt.samples.length === 10;
  receipt.ended_at_ct = formatCt();
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  const temporary = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, out);
  process.stdout.write(`passed=${receipt.passed} samples=${receipt.samples.length} observed_max_ms=${String(receipt.observed_max_ms)} recommended_pi_timeout_ms=${String(receipt.recommended_pi_timeout_ms)} receipt=${out}\n`);
  if (!receipt.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
