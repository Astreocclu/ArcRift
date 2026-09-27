import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MemoryRecordRepository } from "../../src/services/memory-records";
import { fuseRankings, MemorySearchService } from "../../src/services/memory-search";
import { MEMORY_KERNEL } from "../../src/services/memory-kernel";

describe("curated memory search", () => {
  let root: string;
  let repository: MemoryRecordRepository;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-search-"));
    process.env.SQLITE_DB_PATH = path.join(root, "search.sqlite");
    initSqlite();
    repository = new MemoryRecordRepository(getSqlite());
    repository.upsertSource({ uid: "u-old", source: "fixture", at: "2026-09-26", text: "S".repeat(900) });
    repository.upsertSource({ uid: "u-new", source: "fixture", at: "2026-09-27", text: "new source" });
    repository.insertRecord({ rid: "new", uid: "u-new", source: "fixture", at: "2026-09-27", kind: "decision", scope: "global", subject_key: "rule", text: "current wording", status: "current" });
    repository.insertRecord({ rid: "old", uid: "u-old", source: "fixture", at: "2026-09-26", kind: "decision", scope: "global", subject_key: "rule", text: "ancient searchable phrase", status: "superseded", superseded_by: "new" });
    repository.upsertEmbedding("old", new Array(1024).fill(0));
    repository.upsertEmbedding("new", new Array(1024).fill(0.2));
  });

  afterEach(() => {
    getSqlite().close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses stable RRF tie ordering", () => {
    expect(fuseRankings(["b", "a"], ["a", "b"]).map(item => item.rid)).toEqual(["a", "b"]);
  });

  it("searches all versions, resolves heads, expands bounded source text, and includes the kernel", async () => {
    const service = new MemorySearchService({ db: getSqlite(), embed: async () => new Array(1024).fill(0), kernelEnabled: true });
    const result = await service.search("ancient searchable", { topN: 8 });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ rid: "new", status: "current" });
    expect(result.records[0].matched_rids).toEqual(expect.arrayContaining(["old"]));
    expect(result.records[0].source_text.length).toBeLessThanOrEqual(600);
    expect(result.text.startsWith(MEMORY_KERNEL)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(8000);
  });

  it("drops cyclic aliases and limits deduplicated heads to eight", async () => {
    repository.insertRecord({ rid: "cycle-a", uid: "u-new", source: "fixture", at: "2026-09-27", kind: "lesson", scope: "global", subject_key: "cycle", text: "cycle token", status: "current" });
    repository.insertRecord({ rid: "cycle-b", uid: "u-new", source: "fixture", at: "2026-09-27", kind: "lesson", scope: "global", subject_key: "cycle", text: "cycle token", status: "current" });
    getSqlite().prepare("UPDATE memory_records SET superseded_by='cycle-b' WHERE rid='cycle-a'").run();
    getSqlite().prepare("UPDATE memory_records SET superseded_by='cycle-a' WHERE rid='cycle-b'").run();
    const service = new MemorySearchService({ db: getSqlite(), embed: async () => new Array(1024).fill(0) });
    const result = await service.search("cycle token", { topN: 8 });
    expect(result.records.every(record => !record.rid.startsWith("cycle-"))).toBe(true);
    expect(result.records.length).toBeLessThanOrEqual(8);
  });

  it("uses the exact approved kernel", () => {
    expect(MEMORY_KERNEL).toBe("Handle already-authorized routine Git work yourself under repository rules: commit, push, merge, and resolve conflicts from evidence; report genuine blockers without transferring Git mechanics to Reid.");
  });

  it("omits the kernel unless its cleanroom gate is explicitly enabled", async () => {
    const service = new MemorySearchService({ db: getSqlite(), embed: async () => new Array(1024).fill(0), kernelEnabled: false });
    const result = await service.search("ancient searchable");
    expect(result.text).not.toContain(MEMORY_KERNEL);
  });
});
