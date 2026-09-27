import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { buildMemoryPrefilter } from "../../scripts/build-memory-prefilter";

describe("memory relation prefilter", () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-prefilter-"));
    dbPath = path.join(root, "facts.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE facts(id INTEGER PRIMARY KEY, relation TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO facts(id, relation) VALUES (?, ?)");
    for (let id = 1; id <= 20; id++) insert.run(id, "NOISE");
    insert.run(21, "KEEPER");
    db.close();
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("selects frequent relations with zero memory keepers deterministically", () => {
    const labels = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [
      `af:${index + 1}`,
      { label: index === 20 ? "decision" : "drop" },
    ]));
    const labelsPath = path.join(root, "labels.json");
    fs.writeFileSync(labelsPath, JSON.stringify(labels));
    const first = buildMemoryPrefilter({ dbPath, labelPaths: [labelsPath], minCount: 20 });
    const second = buildMemoryPrefilter({ dbPath, labelPaths: [labelsPath], minCount: 20 });
    expect(first).toEqual(second);
    expect(first.relations).toEqual([{ relation: "NOISE", fact_count: 20, keeper_count: 0 }]);
  });

  it("rejects any fact without exactly one label", () => {
    const labelsPath = path.join(root, "labels.json");
    fs.writeFileSync(labelsPath, JSON.stringify({ "af:1": { label: "drop" } }));
    expect(() => buildMemoryPrefilter({ dbPath, labelPaths: [labelsPath], minCount: 20 })).toThrow(/missing labels/i);
  });
});
