import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface EvidenceManifest {
  version: 1;
  source_mode: "readonly";
  source_db: string;
  source_size: number;
  source_sha256: string;
  wal_present: boolean;
  shm_present: boolean;
  rows: number;
  quarantined: number;
  jsonl_sha256: string;
  generated_at: string;
}

export interface EvidenceExportOptions {
  dbPath: string;
  outDir: string;
  evidenceRoot?: string;
}

const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Output is outside evidence root: ${target}`);
  }
}

function atomicWrite(filePath: string, content: string) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  const handle = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, content, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function exportMemoryEvidence(options: EvidenceExportOptions): EvidenceManifest {
  const dbPath = path.resolve(options.dbPath);
  const outDir = path.resolve(options.outDir);
  const evidenceRoot = path.resolve(options.evidenceRoot ?? outDir);
  assertInside(evidenceRoot, outDir);
  if (!fs.existsSync(dbPath)) throw new Error(`Source database does not exist: ${dbPath}`);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outDir, 0o700);

  const jsonlPath = path.join(outDir, "chat-ingestion.jsonl");
  const quarantinePath = path.join(outDir, "chat-ingestion.quarantine.jsonl");
  const manifestPath = path.join(outDir, "manifest.json");
  for (const target of [jsonlPath, quarantinePath, manifestPath]) {
    assertInside(evidenceRoot, target);
  }
  if (fs.existsSync(manifestPath)) throw new Error(`Completed export already exists: ${manifestPath}`);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let jsonl = "";
  let quarantine = "";
  let rows = 0;
  let quarantined = 0;
  try {
    db.pragma("query_only = ON");
    if (Number(db.pragma("query_only", { simple: true })) !== 1) {
      throw new Error("Failed to enable SQLite query_only mode");
    }
    const jobs = db.prepare(`
      SELECT id, payload, createdAt
      FROM jobs
      WHERE type = 'chat_ingestion'
      ORDER BY createdAt ASC, id ASC
    `).all() as Array<{ id: string; payload: string; createdAt: string }>;

    for (const job of jobs) {
      try {
        const payload = JSON.parse(job.payload);
        if (typeof payload.sessionId !== "string" || typeof payload.rawText !== "string") {
          throw new Error("missing sessionId or rawText");
        }
        const row = {
          job_id: job.id,
          session_id: payload.sessionId,
          platform: typeof payload.platform === "string" ? payload.platform : "unknown",
          message_count: Number.isFinite(payload.messageCount) ? Number(payload.messageCount) : 0,
          created_at: job.createdAt,
          raw_text: payload.rawText,
          sha256: sha256(payload.rawText),
        };
        jsonl += `${JSON.stringify(row)}\n`;
        rows += 1;
      } catch (error) {
        quarantine += `${JSON.stringify({
          job_id: job.id,
          created_at: job.createdAt,
          payload_sha256: sha256(job.payload),
          error: error instanceof Error ? error.message : String(error),
        })}\n`;
        quarantined += 1;
      }
    }
  } finally {
    db.close();
  }

  const stat = fs.statSync(dbPath);
  const manifest: EvidenceManifest = {
    version: 1,
    source_mode: "readonly",
    source_db: dbPath,
    source_size: stat.size,
    source_sha256: sha256(fs.readFileSync(dbPath)),
    wal_present: fs.existsSync(`${dbPath}-wal`),
    shm_present: fs.existsSync(`${dbPath}-shm`),
    rows,
    quarantined,
    jsonl_sha256: sha256(jsonl),
    generated_at: new Date().toISOString(),
  };

  atomicWrite(jsonlPath, jsonl);
  atomicWrite(quarantinePath, quarantine);
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (require.main === module) {
  const dbPath = getArg("--db");
  const outDir = getArg("--out");
  if (!dbPath || !outDir) {
    process.stderr.write("Usage: export-memory-evidence --db <sqlite> --out <evidence-dir>\n");
    process.exit(2);
  }
  try {
    const manifest = exportMemoryEvidence({ dbPath, outDir, evidenceRoot: outDir });
    process.stdout.write(`rows=${manifest.rows} quarantined=${manifest.quarantined} hash_failures=0 source_mode=${manifest.source_mode}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
