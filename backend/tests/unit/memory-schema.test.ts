import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MemoryRecordRepository } from "../../src/services/memory-records";

describe("curated memory schema", () => {
  let root: string;
  let repository: MemoryRecordRepository;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-memory-schema-"));
    process.env.SQLITE_DB_PATH = path.join(root, "memory.sqlite");
    initSqlite();
    repository = new MemoryRecordRepository(getSqlite());
  });

  afterEach(() => {
    getSqlite().close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates the additive schema idempotently without touching legacy rows", () => {
    const db = getSqlite();
    db.prepare("INSERT INTO sessions (id, projectName) VALUES ('legacy', 'Legacy')").run();
    initSqlite();
    expect((getSqlite().prepare("SELECT count(*) AS n FROM sessions").get() as any).n).toBe(1);
    const names = (getSqlite().prepare("SELECT name FROM sqlite_master WHERE name LIKE 'memory_%' OR name='vec_memory_records'").all() as any[]).map(row => row.name);
    expect(names).toEqual(expect.arrayContaining(["memory_sources", "memory_records", "memory_record_fts", "vec_memory_records", "memory_conflict_decisions"]));
  });

  it("enforces status, vector dimensions, FTS parity, and cycle-safe heads", () => {
    repository.upsertSource({ uid: "u1", source: "fixture", at: "2026-09-27", text: "source text" });
    repository.insertRecord({ rid: "head", uid: "u1", source: "fixture", at: "2026-09-27", kind: "decision", scope: "global", subject_key: "git.rule", text: "current rule", sigma: "3", status: "current" });
    repository.insertRecord({ rid: "old", uid: "u1", source: "fixture", at: "2026-09-26", kind: "decision", scope: "global", subject_key: "git.rule", text: "old rule", sigma: "2", status: "superseded", superseded_by: "head" });
    repository.upsertEmbedding("head", new Array(1024).fill(0.1));
    expect(() => repository.upsertEmbedding("old", new Array(768).fill(0.1))).toThrow(/1024/);
    expect(repository.resolveHead("old").rid).toBe("head");
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_record_fts").get() as any).n).toBe(2);
    expect(() => getSqlite().prepare("UPDATE memory_records SET status='wrong' WHERE rid='head'").run()).toThrow();

    repository.insertRecord({ rid: "cycle-a", uid: "u1", source: "fixture", at: "2026-09-27", kind: "lesson", scope: "global", subject_key: "cycle", text: "a", sigma: "2", status: "current" });
    repository.insertRecord({ rid: "cycle-b", uid: "u1", source: "fixture", at: "2026-09-27", kind: "lesson", scope: "global", subject_key: "cycle", text: "b", sigma: "2", status: "current" });
    getSqlite().prepare("UPDATE memory_records SET superseded_by='cycle-b' WHERE rid='cycle-a'").run();
    getSqlite().prepare("UPDATE memory_records SET superseded_by='cycle-a' WHERE rid='cycle-b'").run();
    expect(repository.resolveHead("cycle-a").cycle).toBe(true);
  });

  it("stores quarantine, ledger, pair evidence, and conflict decisions idempotently", () => {
    repository.addQuarantine("af:1", "drop", "fixture");
    repository.addQuarantine("af:1", "drop", "fixture");
    repository.addLedger("af:2", "receipt", { label: "receipt" });
    repository.addSupersessionPair({ pair_id: "p1", old_rid: "old", new_rid: "new", similarity: 0.9, mimo: "conflict", luna: "conflict", sol: null, final: "conflict" });
    repository.decideConflict("p1", "keep_both", "tester", "fixture");
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_quarantine").get() as any).n).toBe(1);
    expect((getSqlite().prepare("SELECT decision FROM memory_conflict_decisions WHERE pair_id='p1'").get() as any).decision).toBe("keep_both");
  });
});
