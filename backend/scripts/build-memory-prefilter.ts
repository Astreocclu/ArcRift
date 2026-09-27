import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const MEMORY_LABELS = new Set(["authority", "decision", "lesson", "preference", "project_fact"]);
const sha256File = (filePath: string) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

export interface PrefilterArtifact {
  version: 1;
  rule: { min_count: number; keeper_labels: string[]; required_keeper_count: 0 };
  source_hashes: Record<string, string>;
  fact_count: number;
  covered_fact_count: number;
  relations: Array<{ relation: string; fact_count: number; keeper_count: number }>;
}

export function buildMemoryPrefilter(options: { dbPath: string; labelPaths: string[]; minCount?: number }): PrefilterArtifact {
  const minCount = options.minCount ?? 20;
  const labels = new Map<number, string>();
  const sourceHashes: Record<string, string> = {};
  for (const labelPath of options.labelPaths) {
    const resolved = path.resolve(labelPath);
    sourceHashes[resolved] = sha256File(resolved);
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as Record<string, { label?: string }>;
    for (const [uid, value] of Object.entries(parsed)) {
      const match = /^af:(\d+)$/.exec(uid);
      if (!match || typeof value.label !== "string") throw new Error(`Invalid fact label entry: ${uid}`);
      const id = Number(match[1]);
      if (labels.has(id)) throw new Error(`Duplicate fact label: ${uid}`);
      labels.set(id, value.label);
    }
  }

  const db = new Database(path.resolve(options.dbPath), { readonly: true, fileMustExist: true });
  let facts: Array<{ id: number; relation: string }>;
  try {
    db.pragma("query_only = ON");
    facts = db.prepare("SELECT id, relation FROM facts ORDER BY id").all() as Array<{ id: number; relation: string }>;
  } finally {
    db.close();
  }
  const missing = facts.filter(fact => !labels.has(fact.id));
  const factIds = new Set(facts.map(fact => fact.id));
  const extras = [...labels.keys()].filter(id => !factIds.has(id));
  if (missing.length > 0) throw new Error(`Missing labels for ${missing.length} facts; first=${missing[0].id}`);
  if (extras.length > 0) throw new Error(`Labels reference ${extras.length} missing facts; first=${extras[0]}`);

  const grouped = new Map<string, { fact_count: number; keeper_count: number }>();
  for (const fact of facts) {
    const current = grouped.get(fact.relation) ?? { fact_count: 0, keeper_count: 0 };
    current.fact_count += 1;
    if (MEMORY_LABELS.has(labels.get(fact.id)!)) current.keeper_count += 1;
    grouped.set(fact.relation, current);
  }
  const relations = [...grouped.entries()]
    .filter(([, counts]) => counts.fact_count >= minCount && counts.keeper_count === 0)
    .map(([relation, counts]) => ({ relation, ...counts }))
    .sort((a, b) => a.relation.localeCompare(b.relation));

  return {
    version: 1,
    rule: { min_count: minCount, keeper_labels: [...MEMORY_LABELS].sort(), required_keeper_count: 0 },
    source_hashes: Object.fromEntries(Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b))),
    fact_count: facts.length,
    covered_fact_count: relations.reduce((sum, relation) => sum + relation.fact_count, 0),
    relations,
  };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (require.main === module) {
  const cleanroom = process.env.ARCRIFT_MEMORY_CLEANROOM ?? "/home/astre/command-center-v2/src/gabriel/state/cleanroom/memory-effectiveness-20260926";
  const dbPath = arg("--db") ?? "/home/astre/ArcRift/backend/ArcRift.db";
  const outPath = arg("--out") ?? path.resolve(process.cwd(), "config/memory-relation-prefilter-v1.json");
  const labelPaths = [
    path.join(cleanroom, "runs/gate-mimo-pro-v2facts.json"),
    path.join(cleanroom, "runs/gate-mimo-pro-v2full.json"),
  ];
  try {
    const artifact = buildMemoryPrefilter({ dbPath, labelPaths });
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    if (process.argv.includes("--verify") && fs.existsSync(outPath)) {
      if (fs.readFileSync(outPath, "utf8") !== serialized) throw new Error(`Prefilter differs from locked artifact: ${outPath}`);
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, serialized, { mode: 0o644 });
    }
    process.stdout.write(`relations=${artifact.relations.length} facts=${artifact.covered_fact_count} keepers=0 deterministic=true\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
