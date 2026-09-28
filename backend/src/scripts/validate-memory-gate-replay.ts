import crypto from "crypto";
import fs from "fs";
import path from "path";
import { validateGateDecision } from "../services/memory-gate";

const KEEPERS = new Set(["authority", "decision", "lesson", "preference", "project_fact"]);

export function mapReplayDecision(prediction: any) {
  return {
    label: prediction.label,
    scope: prediction.scope,
    confidence: prediction.confidence,
    records: KEEPERS.has(prediction.label)
      ? [{ subject_key: prediction.subject_key, text: prediction.record }]
      : [],
  };
}

export function validateReplay(triage: Record<string, any>) {
  const predictions = Object.values(triage).sort((a: any, b: any) => Number(a.i) - Number(b.i));
  const failed: Array<{ i: number; reason: string }> = [];
  let passed = 0;
  for (const prediction of predictions) {
    try {
      validateGateDecision(mapReplayDecision(prediction));
      passed += 1;
    } catch (error) {
      failed.push({ i: Number(prediction.i), reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { total: predictions.length, passed, failed };
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function writeReceipt(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function main(): void {
  const predictionsPath = readArg(process.argv.slice(2), "--predictions");
  const out = readArg(process.argv.slice(2), "--out");
  if (!predictionsPath || !out) throw new Error("Usage: --predictions FILE --out FILE");
  const bytes = fs.readFileSync(predictionsPath);
  const document = JSON.parse(bytes.toString("utf8"));
  if (!document?.triage || typeof document.triage !== "object" || Array.isArray(document.triage)) throw new Error("predictions.triage must be an object");
  const results = validateReplay(document.triage);
  const receipt = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    predictions_sha256: sha256(bytes),
    ...results,
  };
  writeReceipt(path.resolve(out), receipt);
  process.stdout.write(`passed=${results.passed}/${results.total} failed=${results.failed.length} receipt=${path.resolve(out)}\n`);
  process.exitCode = results.passed >= 111 && results.total === 120 ? 0 : 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
