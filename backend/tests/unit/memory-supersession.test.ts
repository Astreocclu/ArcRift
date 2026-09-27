import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MemoryRecordRepository } from "../../src/services/memory-records";
import { MemorySupersessionService } from "../../src/services/memory-supersession";

describe("memory supersession", () => {
  let root: string;
  let repository: MemoryRecordRepository;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-supersession-"));
    process.env.SQLITE_DB_PATH = path.join(root, "db.sqlite");
    initSqlite();
    repository = new MemoryRecordRepository(getSqlite());
    repository.upsertSource({ uid: "old-source", source: "fixture", text: "source" });
    repository.upsertSource({ uid: "new-source", source: "fixture", text: "source" });
    repository.insertRecord({ rid: "old", uid: "old-source", source: "fixture", kind: "decision", scope: "global", subject_key: "x", text: "Use the stable API", status: "current" });
    repository.upsertEmbedding("old", new Array(1024).fill(0.1));
  });
  afterEach(() => { getSqlite().close(); fs.rmSync(root, { recursive: true, force: true }); });

  const candidate = (text: string) => ({ rid: "new", uid: "new-source", source: "fixture", kind: "decision", scope: "global", subject_key: "x", text, status: "current" as const });

  it("collapses exact normalized duplicates without a model", async () => {
    const adjudicate = jest.fn();
    const result = await new MemorySupersessionService(getSqlite(), adjudicate).applyCandidate(candidate("  use   THE stable api "), new Array(1024).fill(0.1));
    expect(adjudicate).not.toHaveBeenCalled();
    expect(result.final).toBe("same");
    expect((getSqlite().prepare("SELECT status, dup_of FROM memory_records WHERE rid='new'").get() as any)).toEqual(expect.objectContaining({ status: "duplicate", dup_of: "old" }));
  });

  it("records model-backed newer and conflict decisions", async () => {
    const newer = new MemorySupersessionService(getSqlite(), async () => "newer");
    expect((await newer.applyCandidate(candidate("Use the stable API v2"), new Array(1024).fill(0.11))).final).toBe("newer");
    expect((getSqlite().prepare("SELECT superseded_by FROM memory_records WHERE rid='old'").get() as any).superseded_by).toBe("new");

    repository.upsertSource({ uid: "third-source", source: "fixture", text: "source" });
    const conflict = new MemorySupersessionService(getSqlite(), async () => "conflict");
    const result = await conflict.applyCandidate({ ...candidate("Contradictory rule"), rid: "third", uid: "third-source" }, new Array(1024).fill(0.12));
    expect(result.final).toBe("conflict");
    expect((getSqlite().prepare("SELECT status FROM memory_records WHERE rid='third'").get() as any).status).toBe("disputed");
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_supersession_pairs WHERE final='conflict'").get() as any).n).toBe(1);
  });

  it("applies conflict decisions to record retrieval state atomically", async () => {
    const conflict = new MemorySupersessionService(getSqlite(), async () => "conflict");
    const result = await conflict.applyCandidate(candidate("Contradictory rule"), new Array(1024).fill(0.12));
    expect(result.pair_id).toBeTruthy();
    repository.decideConflict(result.pair_id!, "keep_old", "reviewer");
    expect((getSqlite().prepare("SELECT status FROM memory_records WHERE rid='old'").get() as any).status).toBe("current");
    expect((getSqlite().prepare("SELECT status, superseded_by FROM memory_records WHERE rid='new'").get() as any)).toMatchObject({ status: "superseded", superseded_by: "old" });
    expect(() => repository.decideConflict(result.pair_id!, "keep_new", "reviewer")).toThrow(/already resolved/);
  });

  it("preserves a record's other unresolved conflicts", async () => {
    const conflict = new MemorySupersessionService(getSqlite(), async () => "conflict");
    const first = await conflict.applyCandidate(candidate("First contradiction"), new Array(1024).fill(0.12));
    repository.upsertSource({ uid: "third-source", source: "fixture", text: "third" });
    repository.insertRecord({ ...candidate("Second contradiction"), rid: "third", uid: "third-source", status: "disputed", conflicts_with: ["old"] });
    repository.upsertEmbedding("third", new Array(1024).fill(0.13));
    getSqlite().prepare("UPDATE memory_records SET conflicts_with=? WHERE rid='old'").run(JSON.stringify(["new", "third"]));
    repository.addSupersessionPair({ pair_id: "old-third", old_rid: "old", new_rid: "third", similarity: null, mimo: "model", luna: null, sol: null, final: "conflict" });
    repository.decideConflict(first.pair_id!, "keep_old", "reviewer");
    const old = getSqlite().prepare("SELECT status, conflicts_with FROM memory_records WHERE rid='old'").get() as any;
    expect(old.status).toBe("disputed");
    expect(JSON.parse(old.conflicts_with)).toContain("third");
    repository.decideConflict("old-third", "keep_old", "reviewer");
    expect((getSqlite().prepare("SELECT status, conflicts_with FROM memory_records WHERE rid='old'").get() as any)).toMatchObject({ status: "current", conflicts_with: "[]" });
  });
});
