import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const MEMORY_LABELS = new Set(["decision", "preference", "authority", "lesson", "project_fact"]);
const ALL_LABELS = new Set([...MEMORY_LABELS, "receipt", "drop"]);
const RELATIONS = new Set(["same", "supersedes", "conflict", "distinct"]);
const MODEL = "xiaomi/mimo-v2.6-pro";
const DEFAULT_CLEANROOM = "/home/astre/command-center-v2/src/gabriel/state/cleanroom/memory-gate-bakeoff-20260926";

export interface TriagePrediction {
  i: number;
  label: string;
  scope: string;
  confidence: number;
  subject_key: string;
  record: string;
}

export interface PairPrediction { p: number; relation: string; confidence: number }
export interface TriageGold { labels: string[]; scope: string }

function route(label: string): "memory" | "ledger" | "drop" {
  return MEMORY_LABELS.has(label) ? "memory" : label === "receipt" ? "ledger" : "drop";
}

function validConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validTriage(value: any, length: number): value is TriagePrediction {
  if (!value || !Number.isInteger(value.i) || value.i < 0 || value.i >= length) return false;
  if (!ALL_LABELS.has(value.label) || !validConfidence(value.confidence)) return false;
  if (typeof value.scope !== "string" || typeof value.subject_key !== "string" || typeof value.record !== "string") return false;
  if (MEMORY_LABELS.has(value.label)) {
    return (value.scope === "global" || value.scope === "project") && value.subject_key.trim().length > 0 && value.record.trim().length > 0;
  }
  return value.scope === "-" && value.subject_key === "" && value.record === "";
}

function validPair(value: any, ids: Set<number>): value is PairPrediction {
  return Boolean(value && Number.isInteger(value.p) && ids.has(value.p) && RELATIONS.has(value.relation) && validConfidence(value.confidence));
}

export function scoreReplay(
  triageInput: TriagePrediction[],
  pairInput: PairPrediction[],
  gold: TriageGold[],
  pairGold: Map<number, string[]>,
) {
  const triage = new Map<number, TriagePrediction>();
  for (const candidate of triageInput) if (validTriage(candidate, gold.length) && !triage.has(candidate.i)) triage.set(candidate.i, candidate);
  const pairs = new Map<number, PairPrediction>();
  const pairIds = new Set(pairGold.keys());
  for (const candidate of pairInput) if (validPair(candidate, pairIds) && !pairs.has(candidate.p)) pairs.set(candidate.p, candidate);

  let routeScore = 0;
  let junkAdmitted = 0;
  for (let i = 0; i < gold.length; i++) {
    const prediction = triage.get(i);
    if (!prediction) continue;
    const goldRoutes = new Set(gold[i].labels.map(route));
    const predictedRoute = route(prediction.label);
    if (goldRoutes.has(predictedRoute)) routeScore++;
    if (!goldRoutes.has("memory") && predictedRoute === "memory") junkAdmitted++;
  }
  let pairScore = 0;
  for (const [id, expected] of pairGold) if (expected.includes(pairs.get(id)?.relation ?? "")) pairScore++;

  const thresholds = {
    triage_well_formed: triage.size === 120,
    route_score: routeScore >= 111,
    junk_admitted: junkAdmitted <= 9,
    pair_well_formed: pairs.size === 20,
    pair_score: pairScore >= 17,
  };
  return {
    triage_well_formed: triage.size,
    route_score: routeScore,
    junk_admitted: junkAdmitted,
    pair_well_formed: pairs.size,
    pair_score: pairScore,
    thresholds,
    selected_mode: Object.values(thresholds).every(Boolean) ? "active" : "shadow",
  };
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJsonl(file: string): any[] {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function readGold(file: string): TriageGold[] {
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1).map((line, index) => {
    const [rawIndex, labels, scope] = line.split("\t");
    if (Number(rawIndex) !== index) throw new Error(`Non-contiguous triage gold at ${rawIndex}`);
    return { labels: labels.split("|"), scope };
  });
}

function parseArgs(args: string[]): { cleanroom: string; out: string; maxCost: number } {
  const read = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const maxCost = Number(read("--max-cost") ?? "0.10");
  const out = read("--out");
  if (!out || !Number.isFinite(maxCost) || maxCost <= 0) throw new Error("Usage: --out FILE [--max-cost USD] [--cleanroom DIR]");
  return { cleanroom: read("--cleanroom") ?? DEFAULT_CLEANROOM, out, maxCost };
}

function triagePrompt(rubric: string, items: any[], indexes: number[]): string {
  const candidates = indexes.map(i => `[${i}] ${items[i].text}`).join("\n\n");
  return `You are the memory gate for a multi-agent system. Classify each numbered candidate memory using the rubric.
Output ONLY one JSON object with this shape: {"outputs":[{"i":0,"label":"decision","scope":"global","confidence":0.9,"subject_key":"stable.dotted.key","record":"One atomic sentence."}]}.
Return exactly one output per candidate. label is one of decision, preference, authority, lesson, project_fact, receipt, drop. scope is global, project, or -; use - for receipt/drop. For receipt/drop, subject_key and record must be empty strings. For memory labels, both must be non-empty.

RUBRIC
${rubric}

CANDIDATES
${candidates}`;
}

function pairsPrompt(pairs: any[]): string {
  const body = pairs.map(pair => `[${pair.pid}]\nOLD: ${pair.old}\nNEW: ${pair.new}`).join("\n\n");
  return `You maintain a memory store. For each numbered pair, decide how NEW (written later) relates to OLD.
Relations:
- same: NEW is a duplicate or restatement of OLD (same content)
- supersedes: NEW replaces OLD as the current value of the same subject
- conflict: NEW contradicts OLD and it is not clear which is current; a human must decide
- distinct: related but different subjects; both stay
Output ONLY one JSON object with this shape: {"outputs":[{"p":0,"relation":"same","confidence":0.9}]}. Return exactly one output per pair.

PAIRS
${body}`;
}

async function main() {
  const { cleanroom, out, maxCost } = parseArgs(process.argv.slice(2));
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required");
  const itemFile = path.join(cleanroom, "data/items.jsonl");
  const pairFile = path.join(cleanroom, "data/pairs.jsonl");
  const goldFile = path.join(cleanroom, "data/gold_triage.tsv");
  const rubricFile = path.join(cleanroom, "data/rubric.md");
  const items = readJsonl(itemFile);
  const pairFixtures = readJsonl(pairFile);
  const gold = readGold(goldFile);
  const pairGold = new Map<number, string[]>(pairFixtures.map(pair => [pair.pid, String(pair.gold).split("|")]));
  if (items.length !== 120 || pairFixtures.length !== 20 || gold.length !== 120) throw new Error("Frozen fixture cardinality mismatch");

  const calls: any[] = [];
  const triage: TriagePrediction[] = [];
  const pairPredictions: PairPrediction[] = [];
  let totalCost = 0;
  let failure: string | null = null;

  const call = async (kind: string, prompt: string): Promise<any[]> => {
    if (totalCost >= maxCost) throw new Error("hard_run_budget_reached");
    const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      reasoning: { effort: "low" },
      temperature: 0,
      max_tokens: 16_000,
      response_format: { type: "json_object" },
      provider: { order: ["xiaomi", "deepinfra"], allow_fallbacks: false },
      usage: { include: true },
    }, { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, timeout: 600_000 });
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`${kind}: missing response content`);
    const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!parsed || !Array.isArray(parsed.outputs)) throw new Error(`${kind}: response outputs must be an array`);
    const cost = Number(response.data?.usage?.cost ?? response.data?.usage?.cost_details?.upstream_inference_cost ?? 0);
    if (!Number.isFinite(cost) || cost < 0) throw new Error(`${kind}: invalid provider cost`);
    totalCost += cost;
    calls.push({
      kind,
      prompt_sha256: sha256(prompt),
      response_sha256: sha256(content),
      model: response.data?.model ?? MODEL,
      usage: response.data?.usage ?? null,
      cost_usd: cost,
    });
    if (totalCost > maxCost) throw new Error("hard_run_budget_exceeded");
    return parsed.outputs;
  };

  try {
    const rubric = fs.readFileSync(rubricFile, "utf8");
    for (let start = 0; start < items.length; start += 20) {
      const indexes = Array.from({ length: Math.min(20, items.length - start) }, (_, offset) => start + offset);
      triage.push(...await call(`triage:${start}-${indexes[indexes.length - 1]}`, triagePrompt(rubric, items, indexes)));
    }
    pairPredictions.push(...await call("pairs:0-19", pairsPrompt(pairFixtures)));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const metrics = scoreReplay(triage, pairPredictions, gold, pairGold);
  if (failure) metrics.selected_mode = "shadow";
  const receipt = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    model: MODEL,
    reasoning_effort: "low",
    max_cost_usd: maxCost,
    total_cost_usd: totalCost,
    fixture_hashes: {
      items_sha256: sha256(fs.readFileSync(itemFile)),
      pairs_sha256: sha256(fs.readFileSync(pairFile)),
      gold_sha256: sha256(fs.readFileSync(goldFile)),
      rubric_sha256: sha256(fs.readFileSync(rubricFile)),
    },
    calls,
    metrics,
    failure,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  const temporary = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, out);
  fs.chmodSync(out, 0o600);
  process.stdout.write(`mode=${metrics.selected_mode} triage=${metrics.triage_well_formed}/120 route=${metrics.route_score}/120 junk=${metrics.junk_admitted}/120 pairs=${metrics.pair_well_formed}/20 pair_score=${metrics.pair_score}/20 cost=$${totalCost.toFixed(6)}${failure ? ` failure=${failure}` : ""}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
