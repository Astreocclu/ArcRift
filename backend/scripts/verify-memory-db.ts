import Database from "better-sqlite3";
import sqliteVec from "sqlite-vec";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

function main() {
  const dbPath = arg("--db") ?? process.env.SQLITE_DB_PATH;
  const production = process.argv.includes("--production");
  if (!dbPath) throw new Error("--db is required");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(db);
    db.pragma("query_only = ON");
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    const legacy = {
      jobs: count(db, "SELECT count(*) AS n FROM jobs"),
      chat_jobs: count(db, "SELECT count(*) AS n FROM jobs WHERE type='chat_ingestion'"),
      facts: count(db, "SELECT count(*) AS n FROM facts"),
      full_chats: count(db, "SELECT count(*) AS n FROM full_chats"),
      sessions: count(db, "SELECT count(*) AS n FROM sessions"),
    };
    const expectedLegacy = { jobs: 8412, chat_jobs: 2962, facts: 28082, full_chats: 20, sessions: 20 };
    if (integrity !== "ok" || JSON.stringify(legacy) !== JSON.stringify(expectedLegacy)) {
      throw new Error(`Legacy verification failed: integrity=${integrity} counts=${JSON.stringify(legacy)}`);
    }
    if (!production) {
      process.stdout.write(`integrity=ok jobs=${legacy.jobs} chat_jobs=${legacy.chat_jobs} facts=${legacy.facts} full_chats=${legacy.full_chats} sessions=${legacy.sessions}\n`);
      return;
    }
    const memory = {
      sources: count(db, "SELECT count(*) AS n FROM memory_sources"),
      records: count(db, "SELECT count(*) AS n FROM memory_records"),
      current: count(db, "SELECT count(*) AS n FROM memory_records WHERE status='current'"),
      disputed: count(db, "SELECT count(*) AS n FROM memory_records WHERE status='disputed'"),
      duplicate: count(db, "SELECT count(*) AS n FROM memory_records WHERE status='duplicate'"),
      superseded: count(db, "SELECT count(*) AS n FROM memory_records WHERE status='superseded'"),
      quarantine: count(db, "SELECT count(*) AS n FROM memory_quarantine"),
      ledger: count(db, "SELECT count(*) AS n FROM memory_ledger"),
      pairs: count(db, "SELECT count(*) AS n FROM memory_supersession_pairs"),
      conflicts: count(db, "SELECT count(*) AS n FROM memory_supersession_pairs WHERE final='conflict'"),
      fts: count(db, "SELECT count(*) AS n FROM memory_record_fts"),
      vectors: count(db, "SELECT count(*) AS n FROM vec_memory_records"),
      dimension_errors: count(db, "SELECT count(*) AS n FROM vec_memory_records WHERE vec_length(embedding) != 1024"),
      orphan_sources: count(db, "SELECT count(*) AS n FROM memory_records r LEFT JOIN memory_sources s ON s.uid=r.uid WHERE s.uid IS NULL"),
      orphan_links: count(db, `SELECT count(*) AS n FROM memory_records r
        WHERE (r.dup_of IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memory_records x WHERE x.rid=r.dup_of))
           OR (r.superseded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memory_records x WHERE x.rid=r.superseded_by))`),
    };
    const expected = { sources: 28471, records: 3803, current: 2353, disputed: 185, duplicate: 851, superseded: 414, quarantine: 24512, ledger: 616, pairs: 4841, conflicts: 190, fts: 3803, vectors: 3803, dimension_errors: 0, orphan_sources: 0, orphan_links: 0 };
    if (JSON.stringify(memory) !== JSON.stringify(expected)) throw new Error(`Memory verification failed: ${JSON.stringify(memory)}`);
    process.stdout.write(`integrity=ok legacy=${JSON.stringify(legacy)} memory=${JSON.stringify(memory)}\n`);
  } finally {
    db.close();
  }
}

try { main(); }
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
