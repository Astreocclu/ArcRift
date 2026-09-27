import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { initSqlite, getSqlite } from "../src/services/sqlite";
import { MemoryRecordRepository } from "../src/services/memory-records";
import { MemoryRecord, MemorySource, MemoryRecordStatus } from "../src/services/storage.types";

export interface MemoryV5Paths {
  pool: string;
  records: string;
  embeddings: string;
  quarantine: string;
  gateLabels: string[];
  pairs: string;
}

export interface MemoryImportResult {
  sources: number;
  records: number;
  vectors: number;
  fts: number;
  quarantine: number;
  ledger: number;
  pairs: number;
  orphan_links: number;
  orphan_sources: number;
  dimension_errors: number;
  source_hashes: Record<string, string>;
}

const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

function readJsonl<T>(filePath: string): T[] {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
}

export function importMemoryV5(options: { db: Database.Database; paths: MemoryV5Paths }): MemoryImportResult {
  const { db, paths } = options;
  const allPaths = [paths.pool, paths.records, paths.embeddings, paths.quarantine, paths.pairs, ...paths.gateLabels].map(file => path.resolve(file));
  for (const file of allPaths) if (!fs.existsSync(file)) throw new Error(`Missing import artifact: ${file}`);
  const sourceHashes = Object.fromEntries(allPaths.sort().map(file => [file, sha256(fs.readFileSync(file))]));

  const sources = readJsonl<MemorySource>(paths.pool);
  const records = readJsonl<MemoryRecord>(paths.records);
  const embeddings = JSON.parse(fs.readFileSync(paths.embeddings, "utf8")) as number[][];
  const pairs = JSON.parse(fs.readFileSync(paths.pairs, "utf8")) as Array<Record<string, unknown>>;
  const quarantine = fs.readFileSync(paths.quarantine, "utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#"));

  const sourceIds = new Set<string>();
  for (const source of sources) {
    assertString(source.uid, "source uid");
    assertString(source.source, `source ${source.uid} origin`);
    assertString(source.text, `source ${source.uid} text`);
    if (sourceIds.has(source.uid)) throw new Error(`Duplicate source uid: ${source.uid}`);
    sourceIds.add(source.uid);
  }

  const validStatuses = new Set<MemoryRecordStatus>(["current", "disputed", "duplicate", "superseded"]);
  const recordIds = new Set<string>();
  let orphanSources = 0;
  for (const record of records) {
    assertString(record.rid, "record rid");
    assertString(record.uid, `record ${record.rid} uid`);
    assertString(record.text, `record ${record.rid} text`);
    if (!validStatuses.has(record.status)) throw new Error(`Invalid status for ${record.rid}: ${record.status}`);
    if (recordIds.has(record.rid)) throw new Error(`Duplicate record rid: ${record.rid}`);
    recordIds.add(record.rid);
    if (!sourceIds.has(record.uid)) orphanSources += 1;
  }
  if (orphanSources > 0) throw new Error(`Orphan sources: ${orphanSources}`);

  let orphanLinks = 0;
  for (const record of records) {
    for (const target of [record.dup_of, record.superseded_by, ...(record.conflicts_with ?? [])]) {
      if (target && !recordIds.has(target)) orphanLinks += 1;
    }
  }
  if (orphanLinks > 0) throw new Error(`Missing link target count: ${orphanLinks}`);
  if (embeddings.length !== records.length) throw new Error(`Embedding count ${embeddings.length} does not match record count ${records.length}`);
  const dimensionErrors = embeddings.filter(vector => !Array.isArray(vector) || vector.length !== 1024 || vector.some(value => !Number.isFinite(value))).length;
  if (dimensionErrors > 0) throw new Error(`Embedding dimension errors: ${dimensionErrors}`);
  const pairDecisions = new Set(["same", "newer", "older", "conflict", "unrelated"]);
  for (const pair of pairs) {
    assertString(pair.old, "pair old rid");
    assertString(pair.new, "pair new rid");
    assertString(pair.final, "pair final decision");
    if (!recordIds.has(pair.old) || !recordIds.has(pair.new)) throw new Error(`Pair references a missing record: ${pair.old} -> ${pair.new}`);
    if (!pairDecisions.has(pair.final)) throw new Error(`Invalid pair final decision: ${pair.final}`);
  }

  const labels = new Map<string, any>();
  for (const labelPath of paths.gateLabels) {
    const parsed = JSON.parse(fs.readFileSync(labelPath, "utf8")) as Record<string, any>;
    for (const [uid, value] of Object.entries(parsed)) {
      if (labels.has(uid)) throw new Error(`Duplicate gate uid: ${uid}`);
      if (!value || typeof value.label !== "string") throw new Error(`Invalid gate result: ${uid}`);
      labels.set(uid, value);
    }
  }
  for (const uid of quarantine) {
    if (!labels.has(uid) || labels.get(uid).label !== "drop") throw new Error(`Quarantine uid is not a routed drop: ${uid}`);
  }
  const ledger = [...labels.entries()].filter(([, value]) => value.label === "receipt");

  const repository = new MemoryRecordRepository(db);
  repository.transaction(() => {
    for (const source of sources) repository.upsertSource(source);
    for (const record of records) repository.insertRecord({ ...record, dup_of: null, superseded_by: null });
    for (const record of records) repository.updateLinks(record.rid, record.dup_of, record.superseded_by);
    for (let index = 0; index < records.length; index++) repository.upsertEmbedding(records[index].rid, embeddings[index]);
    for (const uid of quarantine) repository.addQuarantine(uid, "cleanroom-v5-drop", "gate-v2");
    for (const [uid, value] of ledger) repository.addLedger(uid, "receipt", value);
    for (const pair of pairs) {
      const pairId = sha256(`${pair.old}\0${pair.new}`);
      repository.addSupersessionPair({
        pair_id: pairId,
        old_rid: pair.old as string,
        new_rid: pair.new as string,
        similarity: typeof pair.sim === "number" ? pair.sim : null,
        mimo: typeof pair.mimo === "string" ? pair.mimo : null,
        luna: typeof pair.luna === "string" ? pair.luna : null,
        sol: typeof pair.sol === "string" ? pair.sol : null,
        final: pair.final as string,
      });
    }
  });

  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const foreignKeys = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeys.length > 0) throw new Error(`Foreign key violations after import: ${foreignKeys.length}`);
  return {
    sources: count("memory_sources"),
    records: count("memory_records"),
    vectors: count("vec_memory_records"),
    fts: count("memory_record_fts"),
    quarantine: count("memory_quarantine"),
    ledger: count("memory_ledger"),
    pairs: count("memory_supersession_pairs"),
    orphan_links: 0,
    orphan_sources: 0,
    dimension_errors: 0,
    source_hashes: sourceHashes,
  };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (require.main === module) {
  const cleanroom = arg("--cleanroom") ?? process.env.ARCRIFT_MEMORY_CLEANROOM ?? "/home/astre/command-center-v2/src/gabriel/state/cleanroom/memory-effectiveness-20260926";
  const dbPath = arg("--db");
  if (!dbPath) {
    process.stderr.write("Usage: import-memory-v5 --db <sqlite> [--cleanroom <dir>]\n");
    process.exit(2);
  }
  process.env.SQLITE_DB_PATH = path.resolve(dbPath);
  try {
    initSqlite();
    const result = importMemoryV5({
      db: getSqlite(),
      paths: {
        pool: path.join(cleanroom, "data/pool_full.jsonl"),
        records: path.join(cleanroom, "data/records_final-v5.jsonl"),
        embeddings: path.join(cleanroom, "data/records-v5.emb.json"),
        quarantine: path.join(cleanroom, "data/quarantine-v5.txt"),
        gateLabels: [path.join(cleanroom, "runs/gate-mimo-pro-v2facts.json"), path.join(cleanroom, "runs/gate-mimo-pro-v2full.json")],
        pairs: path.join(cleanroom, "runs/supersession_pairs-v5.json"),
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    getSqlite().close();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
