import Database from "better-sqlite3";
import crypto from "crypto";
import { getSqlite } from "./sqlite";
import { MemoryRecord, MemorySource } from "./storage.types";

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export interface HeadResolution {
  rid: string;
  hops: number;
  cycle: boolean;
  truncated: boolean;
}

export interface SupersessionPair {
  pair_id: string;
  old_rid: string;
  new_rid: string;
  similarity: number | null;
  mimo: string | null;
  luna: string | null;
  sol: string | null;
  final: string;
}

export class MemoryRecordRepository {
  constructor(public readonly db: Database.Database = getSqlite()) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  upsertSource(source: MemorySource) {
    this.db.prepare(`
      INSERT INTO memory_sources(uid, source, at, text, sha256)
      VALUES (@uid, @source, @at, @text, @sha256)
      ON CONFLICT(uid) DO UPDATE SET
        source=excluded.source, at=excluded.at, text=excluded.text, sha256=excluded.sha256
    `).run({ ...source, at: source.at ?? null, sha256: sha256(source.text) });
  }

  insertRecord(record: MemoryRecord) {
    this.db.prepare(`
      INSERT INTO memory_records(
        rid, uid, source, at, kind, scope, subject_key, text, sigma,
        status, dup_of, superseded_by, conflicts_with
      ) VALUES (
        @rid, @uid, @source, @at, @kind, @scope, @subject_key, @text, @sigma,
        @status, @dup_of, @superseded_by, @conflicts_with
      )
      ON CONFLICT(rid) DO UPDATE SET
        uid=excluded.uid, source=excluded.source, at=excluded.at,
        kind=excluded.kind, scope=excluded.scope, subject_key=excluded.subject_key,
        text=excluded.text, sigma=excluded.sigma, status=excluded.status,
        dup_of=excluded.dup_of, superseded_by=excluded.superseded_by,
        conflicts_with=excluded.conflicts_with
    `).run({
      ...record,
      at: record.at ?? null,
      subject_key: record.subject_key ?? null,
      sigma: record.sigma ?? null,
      dup_of: record.dup_of ?? null,
      superseded_by: record.superseded_by ?? null,
      conflicts_with: JSON.stringify(record.conflicts_with ?? []),
    });
  }

  updateLinks(rid: string, dupOf?: string | null, supersededBy?: string | null) {
    this.db.prepare("UPDATE memory_records SET dup_of = ?, superseded_by = ? WHERE rid = ?")
      .run(dupOf ?? null, supersededBy ?? null, rid);
  }

  upsertEmbedding(rid: string, embedding: number[]) {
    if (embedding.length !== 1024 || embedding.some(value => !Number.isFinite(value))) {
      throw new Error(`Memory embeddings must contain exactly 1024 finite values; received ${embedding.length}`);
    }
    const vector = Buffer.from(new Float32Array(embedding).buffer);
    const updated = this.db.prepare("UPDATE vec_memory_records SET embedding = ? WHERE record_id = ?").run(vector, rid);
    if (updated.changes === 0) {
      this.db.prepare("INSERT INTO vec_memory_records(record_id, embedding) VALUES (?, ?)").run(rid, vector);
    }
  }

  resolveHead(startRid: string, maxHops = 10): HeadResolution {
    const seen = new Set<string>();
    let rid = startRid;
    let hops = 0;
    while (hops < maxHops) {
      if (seen.has(rid)) return { rid, hops, cycle: true, truncated: false };
      seen.add(rid);
      const row = this.db.prepare("SELECT dup_of, superseded_by FROM memory_records WHERE rid = ?").get(rid) as
        { dup_of: string | null; superseded_by: string | null } | undefined;
      if (!row) throw new Error(`Unknown memory record: ${rid}`);
      const next = row.superseded_by ?? row.dup_of;
      if (!next) return { rid, hops, cycle: false, truncated: false };
      rid = next;
      hops += 1;
    }
    return { rid, hops, cycle: false, truncated: true };
  }

  addQuarantine(uid: string, reason: string, source?: string | null) {
    this.db.prepare(`
      INSERT INTO memory_quarantine(uid, reason, source, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET reason=excluded.reason, source=excluded.source
    `).run(uid, reason, source ?? null, new Date().toISOString());
  }

  addLedger(uid: string, kind: string, payload: unknown) {
    this.db.prepare(`
      INSERT INTO memory_ledger(uid, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET kind=excluded.kind, payload_json=excluded.payload_json
    `).run(uid, kind, JSON.stringify(payload), new Date().toISOString());
  }

  addSupersessionPair(pair: SupersessionPair) {
    this.db.prepare(`
      INSERT INTO memory_supersession_pairs(pair_id, old_rid, new_rid, similarity, mimo, luna, sol, final)
      VALUES (@pair_id, @old_rid, @new_rid, @similarity, @mimo, @luna, @sol, @final)
      ON CONFLICT(pair_id) DO UPDATE SET
        old_rid=excluded.old_rid, new_rid=excluded.new_rid,
        similarity=excluded.similarity, mimo=excluded.mimo, luna=excluded.luna,
        sol=excluded.sol, final=excluded.final
    `).run(pair);
  }

  decideConflict(pairId: string, decision: "keep_old" | "keep_new" | "keep_both" | "same", decidedBy: string, note?: string) {
    this.db.prepare(`
      INSERT INTO memory_conflict_decisions(pair_id, decision, decided_by, note, decided_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pair_id) DO UPDATE SET
        decision=excluded.decision, decided_by=excluded.decided_by,
        note=excluded.note, decided_at=excluded.decided_at
    `).run(pairId, decision, decidedBy, note ?? null, new Date().toISOString());
  }
}
