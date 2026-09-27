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
});
