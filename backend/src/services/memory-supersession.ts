import Database from "better-sqlite3";
import crypto from "crypto";
import { MemoryRecordRepository } from "./memory-records";
import { MemoryRecord } from "./storage.types";

export type SupersessionDecision = "same" | "newer" | "older" | "conflict" | "unrelated";
export type SupersessionAdjudicator = (oldRecord: MemoryRecord, newRecord: MemoryRecord, similarity: number | null) => Promise<SupersessionDecision>;
export interface SupersessionPlan { final: SupersessionDecision; pair_id?: string; matched_rid?: string; similarity?: number | null; model?: string }
export interface StagedCandidate { record: MemoryRecord; embedding: number[]; plan: SupersessionPlan }

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const pairId = (oldRid: string, newRid: string) => crypto.createHash("sha256").update(`${oldRid}\0${newRid}`).digest("hex");
const cosine = (a: number[], b: number[]) => {
  let dot = 0, aa = 0, bb = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
};

export class MemorySupersessionService {
  private readonly repository: MemoryRecordRepository;
  constructor(private readonly db: Database.Database, private readonly adjudicate: SupersessionAdjudicator) {
    this.repository = new MemoryRecordRepository(db);
  }

  async applyCandidate(record: MemoryRecord, embedding: number[]): Promise<{ final: SupersessionDecision; pair_id?: string; matched_rid?: string }> {
    const plan = await this.planCandidate(record, embedding);
    this.repository.transaction(() => this.applyPlan(record, embedding, plan));
    return { final: plan.final, pair_id: plan.pair_id, matched_rid: plan.matched_rid };
  }

  async planCandidate(record: MemoryRecord, embedding: number[], staged: StagedCandidate[] = []): Promise<SupersessionPlan> {
    const stagedSuperseded = new Set(staged.filter(item => item.plan.final === "newer").map(item => item.plan.matched_rid));
    const stagedLive = staged
      .filter(item => !["same", "older"].includes(item.plan.final))
      .map(item => ({ ...item.record, conflicts_with: item.plan.final === "conflict" ? [item.plan.matched_rid!] : [] }));
    const databaseLive = (this.db.prepare("SELECT * FROM memory_records WHERE status IN ('current','disputed') ORDER BY rid").all() as any[])
      .filter(row => !stagedSuperseded.has(row.rid));
    const live = [...stagedLive, ...databaseLive];
    const exact = live.find(row => normalize(row.text) === normalize(record.text));
    if (exact) {
      const id = pairId(exact.rid, record.rid);
      return { final: "same", pair_id: id, matched_rid: exact.rid, similarity: 1, model: "deterministic_exact" };
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
      const stagedEligible = staged
        .filter(item => !["same", "older"].includes(item.plan.final))
        .map(item => ({ item, similarity: cosine(item.embedding, embedding) }))
        .filter(item => item.similarity >= 0.75)
        .sort((a, b) => b.similarity - a.similarity)[0];
      if (stagedEligible && (similarity === null || stagedEligible.similarity > similarity)) {
        candidate = stagedEligible.item.record;
        similarity = stagedEligible.similarity;
      }
    }

    if (!candidate) {
      return { final: "unrelated" };
    }
    if (similarity === null && embedding.length === 1024) similarity = null;
    const oldRecord = this.toRecord(candidate);
    const final = await this.adjudicate(oldRecord, record, similarity);
    const id = pairId(oldRecord.rid, record.rid);
    return { final, pair_id: id, matched_rid: oldRecord.rid, similarity, model: "model" };
  }

  applyPlan(record: MemoryRecord, embedding: number[], plan: SupersessionPlan): void {
    const stored = { ...record };
    if (plan.final === "same") { stored.status = "duplicate"; stored.dup_of = plan.matched_rid; }
    if (plan.final === "older") { stored.status = "superseded"; stored.superseded_by = plan.matched_rid; }
    if (plan.final === "conflict") { stored.status = "disputed"; stored.conflicts_with = [plan.matched_rid!]; }
    this.repository.insertRecord(stored);
    this.repository.upsertEmbedding(record.rid, embedding);
    if (plan.final === "newer") this.db.prepare("UPDATE memory_records SET status='superseded', superseded_by=? WHERE rid=?").run(record.rid, plan.matched_rid);
    if (plan.final === "conflict") {
      const matched = this.db.prepare("SELECT conflicts_with FROM memory_records WHERE rid=?").get(plan.matched_rid) as { conflicts_with: string } | undefined;
      if (!matched) throw new Error(`Conflict record is missing: ${plan.matched_rid}`);
      const peers = Array.from(new Set([...JSON.parse(matched.conflicts_with || "[]"), record.rid])).sort();
      this.db.prepare("UPDATE memory_records SET status='disputed', conflicts_with=? WHERE rid=?").run(JSON.stringify(peers), plan.matched_rid);
    }
    if (plan.pair_id && plan.matched_rid) {
      this.repository.addSupersessionPair({
        pair_id: plan.pair_id, old_rid: plan.matched_rid, new_rid: record.rid,
        similarity: plan.similarity ?? null, mimo: plan.model ?? "model", luna: null, sol: null, final: plan.final,
      });
    }
  }

  private toRecord(row: any): MemoryRecord {
    return { ...row, conflicts_with: Array.isArray(row.conflicts_with) ? row.conflicts_with : JSON.parse(row.conflicts_with || "[]") };
  }
}
