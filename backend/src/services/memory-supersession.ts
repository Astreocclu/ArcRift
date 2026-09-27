import Database from "better-sqlite3";
import crypto from "crypto";
import { MemoryRecordRepository } from "./memory-records";
import { MemoryRecord } from "./storage.types";

export type SupersessionDecision = "same" | "newer" | "older" | "conflict" | "unrelated";
export type SupersessionAdjudicator = (oldRecord: MemoryRecord, newRecord: MemoryRecord, similarity: number | null) => Promise<SupersessionDecision>;

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const pairId = (oldRid: string, newRid: string) => crypto.createHash("sha256").update(`${oldRid}\0${newRid}`).digest("hex");

export class MemorySupersessionService {
  private readonly repository: MemoryRecordRepository;
  constructor(private readonly db: Database.Database, private readonly adjudicate: SupersessionAdjudicator) {
    this.repository = new MemoryRecordRepository(db);
  }

  async applyCandidate(record: MemoryRecord, embedding: number[]): Promise<{ final: SupersessionDecision; pair_id?: string; matched_rid?: string }> {
    const live = this.db.prepare("SELECT * FROM memory_records WHERE status IN ('current','disputed') ORDER BY rid").all() as any[];
    const exact = live.find(row => normalize(row.text) === normalize(record.text));
    if (exact) {
      const id = pairId(exact.rid, record.rid);
      this.repository.transaction(() => {
        this.repository.insertRecord({ ...record, status: "duplicate", dup_of: exact.rid });
        this.repository.upsertEmbedding(record.rid, embedding);
        this.repository.addSupersessionPair({ pair_id: id, old_rid: exact.rid, new_rid: record.rid, similarity: 1, mimo: "deterministic_exact", luna: null, sol: null, final: "same" });
      });
      return { final: "same", pair_id: id, matched_rid: exact.rid };
    }

    let candidate: any | undefined;
    let similarity: number | null = null;
    if (record.subject_key) candidate = live.find(row => row.subject_key === record.subject_key);
    if (!candidate) {
      const vector = Buffer.from(new Float32Array(embedding).buffer);
      const nearest = this.db.prepare(`SELECT v.record_id, v.distance FROM vec_memory_records v JOIN memory_records r ON r.rid=v.record_id WHERE v.embedding MATCH ? AND k=20 AND r.status IN ('current','disputed') ORDER BY v.distance`).all(vector) as Array<{ record_id: string; distance: number }>;
      const eligible = nearest.map(row => ({ ...row, similarity: Math.max(-1, Math.min(1, 1 - (row.distance * row.distance) / 2)) })).find(row => row.similarity >= 0.75);
      if (eligible) {
        candidate = live.find(row => row.rid === eligible.record_id);
        similarity = eligible.similarity;
      }
    }

    if (!candidate) {
      this.repository.transaction(() => { this.repository.insertRecord(record); this.repository.upsertEmbedding(record.rid, embedding); });
      return { final: "unrelated" };
    }
    if (similarity === null && embedding.length === 1024) similarity = null;
    const oldRecord = this.toRecord(candidate);
    const final = await this.adjudicate(oldRecord, record, similarity);
    const id = pairId(oldRecord.rid, record.rid);
    this.repository.transaction(() => {
      this.repository.insertRecord(record);
      this.repository.upsertEmbedding(record.rid, embedding);
      if (final === "same") this.db.prepare("UPDATE memory_records SET status='duplicate', dup_of=? WHERE rid=?").run(oldRecord.rid, record.rid);
      if (final === "newer") this.db.prepare("UPDATE memory_records SET status='superseded', superseded_by=? WHERE rid=?").run(record.rid, oldRecord.rid);
      if (final === "older") this.db.prepare("UPDATE memory_records SET status='superseded', superseded_by=? WHERE rid=?").run(oldRecord.rid, record.rid);
      if (final === "conflict") {
        this.db.prepare("UPDATE memory_records SET status='disputed', conflicts_with=? WHERE rid=?").run(JSON.stringify([record.rid]), oldRecord.rid);
        this.db.prepare("UPDATE memory_records SET status='disputed', conflicts_with=? WHERE rid=?").run(JSON.stringify([oldRecord.rid]), record.rid);
      }
      this.repository.addSupersessionPair({ pair_id: id, old_rid: oldRecord.rid, new_rid: record.rid, similarity, mimo: "model", luna: null, sol: null, final });
    });
    return { final, pair_id: id, matched_rid: oldRecord.rid };
  }

  private toRecord(row: any): MemoryRecord {
    return { ...row, conflicts_with: JSON.parse(row.conflicts_with || "[]") };
  }
}
