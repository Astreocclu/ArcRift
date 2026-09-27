import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import fs from "fs";
import { logger } from "../utils/logger";

function getDbPath() {
  return process.env.SQLITE_DB_PATH || path.join(process.cwd(), "ArcRift.db");
}

let db: Database.Database;

export function initSqlite() {
  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);
  if (dbPath !== ":memory:" && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000"); // Wait up to 5s if DB is locked
  
  // Load sqlite-vec extension
  try {
    sqliteVec.load(db);
    logger.success("sqlite-vec extension loaded");
  } catch (err) {
    logger.error("Failed to load sqlite-vec extension. Vector search will be disabled.", err);
  }
  
  logger.success(`SQLite initialized at ${dbPath}`);
  
  createTables();
}

function createTables() {
  // Sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      projectName TEXT NOT NULL,
      platform TEXT,
      summary TEXT,
      tripleCount INTEGER DEFAULT 0,
      topicCount INTEGER DEFAULT 0,
      hasFullChat INTEGER DEFAULT 0,
      createdAt TEXT,
      updatedAt TEXT,
      externalChatId TEXT UNIQUE
    )
  `);

  // Migration: Add externalChatId column if it doesn't exist
  try {
    const tableInfo = db.prepare("PRAGMA table_info(sessions)").all() as any[];
    const hasCol = tableInfo.some(col => col.name === "externalChatId");
    if (!hasCol) {
      // SQLite does NOT allow adding a UNIQUE column via ALTER TABLE
      // We must add it normally and then create a UNIQUE INDEX
      db.exec("ALTER TABLE sessions ADD COLUMN externalChatId TEXT");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_externalChatId ON sessions(externalChatId)");
      logger.info("Database migration: Added externalChatId column and unique index");
    }

    const hasTokens = tableInfo.some(col => col.name === "tokensSaved");
    if (!hasTokens) {
      db.exec("ALTER TABLE sessions ADD COLUMN tokensSaved INTEGER DEFAULT 0");
      db.exec("ALTER TABLE sessions ADD COLUMN retrievalCount INTEGER DEFAULT 0");
      logger.info("Database migration: Added analytics columns to sessions (v1.5.5)");
    }
  } catch (e) {
    logger.warn(`Database migration warning: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Full Chats
  db.exec(`
    CREATE TABLE IF NOT EXISTS full_chats (
      sessionId TEXT PRIMARY KEY,
      rawText TEXT NOT NULL,
      processedText TEXT,
      messageCount INTEGER DEFAULT 0,
      platform TEXT,
      createdAt TEXT,
      FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Migration: Add processedText to full_chats if missing (v1.4.7)
  try {
    const tableInfo = db.prepare("PRAGMA table_info(full_chats)").all() as any[];
    if (!tableInfo.some(col => col.name === "processedText")) {
      db.exec("ALTER TABLE full_chats ADD COLUMN processedText TEXT");
      logger.info("Database migration: Added processedText to full_chats");
    }
  } catch (e) {
    logger.warn(`FullChat migration warning: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Active Session
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_session (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      sessionId TEXT,
      FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE SET NULL
    )
  `);
  db.exec("INSERT OR IGNORE INTO active_session (id, sessionId) VALUES ('singleton', NULL)");

  // Jobs
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING',
      deadLettered INTEGER DEFAULT 0,
      failedAt TEXT,
      error TEXT,
      attempts INTEGER DEFAULT 0,
      createdAt TEXT,
      updatedAt TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, createdAt)");

  // Facts (Knowledge Graph)
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      subject TEXT NOT NULL,
      subjectType TEXT,
      relation TEXT NOT NULL,
      object TEXT NOT NULL,
      objectType TEXT,
      timestamp TEXT,
      FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(sessionId)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_unique ON facts(sessionId, subject, relation, object)");

  // Vectors (RAG)
  // sqlite-vec uses virtual tables for vector search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding float[768]
    )
  `);
  
  // Metadata for chunks (since vec0 is just for search)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_metadata (
      chunk_id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      chunkIndex INTEGER,
      content TEXT NOT NULL,
      filePath TEXT,
      fileHash TEXT,
      FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  
  // Migration: Add filePath and fileHash to chunk_metadata (v1.5.6)
  try {
    const tableInfo = db.prepare("PRAGMA table_info(chunk_metadata)").all() as any[];
    if (!tableInfo.some(col => col.name === "filePath")) {
      db.exec("ALTER TABLE chunk_metadata ADD COLUMN filePath TEXT");
      db.exec("ALTER TABLE chunk_metadata ADD COLUMN fileHash TEXT");
      logger.info("Database migration: Added filePath and fileHash to chunk_metadata (v1.5.6)");
    }
  } catch (e) {
    logger.warn(`chunk_metadata migration warning: ${e instanceof Error ? e.message : String(e)}`);
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunk_metadata(sessionId)");

  // High-precision Sentence Vectors (Small-to-Big Retrieval)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_sentences USING vec0(
      sentence_id TEXT PRIMARY KEY,
      embedding float[768]
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sentence_metadata (
      sentence_id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL,
      content TEXT NOT NULL,
      FOREIGN KEY(chunk_id) REFERENCES chunk_metadata(chunk_id) ON DELETE CASCADE
    )
  `);

  // Hybrid Search (FTS5)
  // Indices text for fast keyword matching
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
      chunk_id UNINDEXED,
      content,
      tokenize='porter'
    )
  `);

  // Curated memory projection. This is deliberately separate from the legacy
  // 768-dimensional chunk index so both paths can be rolled back independently.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sources (
      uid TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      at TEXT,
      text TEXT NOT NULL,
      sha256 TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_records (
      rid TEXT PRIMARY KEY,
      uid TEXT NOT NULL REFERENCES memory_sources(uid),
      source TEXT NOT NULL,
      at TEXT,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      subject_key TEXT,
      text TEXT NOT NULL,
      sigma TEXT,
      status TEXT NOT NULL CHECK(status IN ('current', 'disputed', 'duplicate', 'superseded')),
      dup_of TEXT REFERENCES memory_records(rid) DEFERRABLE INITIALLY DEFERRED,
      superseded_by TEXT REFERENCES memory_records(rid) DEFERRABLE INITIALLY DEFERRED,
      conflicts_with TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_records_uid ON memory_records(uid);
    CREATE INDEX IF NOT EXISTS idx_memory_records_subject ON memory_records(subject_key);
    CREATE INDEX IF NOT EXISTS idx_memory_records_status ON memory_records(status);

    CREATE TABLE IF NOT EXISTS memory_quarantine (
      uid TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_ledger (
      uid TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_supersession_pairs (
      pair_id TEXT PRIMARY KEY,
      old_rid TEXT NOT NULL,
      new_rid TEXT NOT NULL,
      similarity REAL,
      mimo TEXT,
      luna TEXT,
      sol TEXT,
      final TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_conflict_decisions (
      pair_id TEXT PRIMARY KEY REFERENCES memory_supersession_pairs(pair_id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK(decision IN ('keep_old', 'keep_new', 'keep_both', 'same')),
      decided_by TEXT NOT NULL,
      note TEXT,
      decided_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ct_date TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      cost_usd REAL NOT NULL CHECK(cost_usd >= 0),
      request_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_usage_date ON memory_usage(ct_date);
    CREATE TABLE IF NOT EXISTS memory_budget_reservations (
      reservation_id TEXT PRIMARY KEY,
      ct_date TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      reserved_usd REAL NOT NULL CHECK(reserved_usd >= 0),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_budget_reservations_date ON memory_budget_reservations(ct_date);
    CREATE TABLE IF NOT EXISTS memory_usage_warnings (
      ct_date TEXT PRIMARY KEY,
      warned_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_proposals (
      idempotency_key TEXT PRIMARY KEY,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_record_fts USING fts5(
      rid UNINDEXED,
      text,
      subject_key,
      kind,
      scope,
      tokenize='porter'
    );
    CREATE TRIGGER IF NOT EXISTS memory_records_fts_insert AFTER INSERT ON memory_records BEGIN
      INSERT INTO memory_record_fts(rid, text, subject_key, kind, scope)
      VALUES (new.rid, new.text, coalesce(new.subject_key, ''), new.kind, new.scope);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_records_fts_delete AFTER DELETE ON memory_records BEGIN
      DELETE FROM memory_record_fts WHERE rid = old.rid;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_records_fts_update AFTER UPDATE ON memory_records BEGIN
      DELETE FROM memory_record_fts WHERE rid = old.rid;
      INSERT INTO memory_record_fts(rid, text, subject_key, kind, scope)
      VALUES (new.rid, new.text, coalesce(new.subject_key, ''), new.kind, new.scope);
    END;
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_records USING vec0(
      record_id TEXT PRIMARY KEY,
      embedding float[1024]
    )
  `);

  logger.success("All SQLite tables initialized successfully");
}

export function getSqlite(): Database.Database {
  if (!db) initSqlite();
  return db;
}
