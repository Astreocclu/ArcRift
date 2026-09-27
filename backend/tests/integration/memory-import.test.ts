import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { importMemoryV5 } from "../../scripts/import-memory-v5";

describe("v5 curated memory importer", () => {
  let root: string;
  let paths: any;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-import-"));
    process.env.SQLITE_DB_PATH = path.join(root, "target.sqlite");
    initSqlite();
    const write = (name: string, value: string) => {
      const target = path.join(root, name);
      fs.writeFileSync(target, value);
      return target;
    };
    paths = {
      pool: write("pool.jsonl", [
        JSON.stringify({ uid: "u1", source: "fixture", at: "2026-09-26", text: "old source" }),
        JSON.stringify({ uid: "u2", source: "fixture", at: "2026-09-27", text: "new source" }),
      ].join("\n") + "\n"),
      records: write("records.jsonl", [
        JSON.stringify({ rid: "old", uid: "u1", source: "fixture", at: "2026-09-26", kind: "decision", scope: "global", subject_key: "x", text: "old", sigma: "2", status: "superseded", superseded_by: "new" }),
        JSON.stringify({ rid: "new", uid: "u2", source: "fixture", at: "2026-09-27", kind: "decision", scope: "global", subject_key: "x", text: "new", sigma: "3", status: "current" }),
      ].join("\n") + "\n"),
      embeddings: write("emb.json", JSON.stringify([new Array(1024).fill(0.1), new Array(1024).fill(0.2)])),
      quarantine: write("quarantine.txt", "# routed drop count: 1\naf:1\n"),
      gateLabels: [write("gate-a.json", JSON.stringify({ "af:1": { label: "drop" } })), write("gate-b.json", JSON.stringify({ "af:2": { label: "receipt", records: [] } }))],
      pairs: write("pairs.json", JSON.stringify([{ old: "old", new: "new", sim: 0.9, mimo: "newer", luna: null, sol: null, final: "newer" }])),
    };
  });

  afterEach(() => {
    getSqlite().close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("preserves versions, links, sources, vectors, routes, and pair evidence idempotently", () => {
    const first = importMemoryV5({ db: getSqlite(), paths });
    const second = importMemoryV5({ db: getSqlite(), paths });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ sources: 2, records: 2, vectors: 2, fts: 2, quarantine: 1, ledger: 1, pairs: 1, orphan_links: 0, orphan_sources: 0, dimension_errors: 0 });
    expect((getSqlite().prepare("SELECT superseded_by FROM memory_records WHERE rid='old'").get() as any).superseded_by).toBe("new");
  });

  it("rejects broken links before starting the transaction", () => {
    const rows = fs.readFileSync(paths.records, "utf8").replace('"superseded_by":"new"', '"superseded_by":"missing"');
    fs.writeFileSync(paths.records, rows);
    expect(() => importMemoryV5({ db: getSqlite(), paths })).toThrow(/missing link target/i);
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_records").get() as any).n).toBe(0);
  });

  it("rejects invalid pair references before starting the transaction", () => {
    fs.writeFileSync(paths.pairs, JSON.stringify([{ old: "old", new: "missing", final: "newer" }]));
    expect(() => importMemoryV5({ db: getSqlite(), paths })).toThrow(/pair references a missing record/i);
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_records").get() as any).n).toBe(0);
  });
});
