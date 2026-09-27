import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { exportMemoryEvidence } from "../../scripts/export-memory-evidence";

describe("memory evidence exporter", () => {
  let root: string;
  let dbPath: string;
  let outDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-evidence-"));
    dbPath = path.join(root, "source.sqlite");
    outDir = path.join(root, "evidence");
    fs.mkdirSync(outDir, { mode: 0o700 });
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`);
    const insert = db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)");
    insert.run("j2", "chat_ingestion", JSON.stringify({ sessionId: "s1", rawText: "second", platform: "claude", messageCount: 2 }), "2026-09-27T02:00:00Z");
    insert.run("j1", "chat_ingestion", JSON.stringify({ sessionId: "s1", rawText: "first", platform: "codex", messageCount: 1 }), "2026-09-27T01:00:00Z");
    insert.run("bad", "chat_ingestion", "{", "2026-09-27T03:00:00Z");
    insert.run("other", "triple_extraction", "{}", "2026-09-27T00:00:00Z");
    db.close();
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("exports every valid chat job independently in deterministic order", () => {
    const before = fs.readFileSync(dbPath);
    const manifest = exportMemoryEvidence({ dbPath, outDir });
    expect(manifest.rows).toBe(2);
    expect(manifest.quarantined).toBe(1);
    const rows = fs.readFileSync(path.join(outDir, "chat-ingestion.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.job_id)).toEqual(["j1", "j2"]);
    expect(rows[0]).toMatchObject({ session_id: "s1", platform: "codex", message_count: 1, raw_text: "first" });
    expect(rows[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(fs.statSync(path.join(outDir, "manifest.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses escape paths and completed-export overwrite", () => {
    expect(() => exportMemoryEvidence({ dbPath, outDir: path.join(outDir, "..") , evidenceRoot: outDir })).toThrow(/outside evidence root/i);
    exportMemoryEvidence({ dbPath, outDir });
    expect(() => exportMemoryEvidence({ dbPath, outDir })).toThrow(/already exists/i);
  });
});
