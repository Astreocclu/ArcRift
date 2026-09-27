import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getSqlite } from "./sqlite";
import { MemoryBudget } from "./memory-budget";
import { MemoryEmbeddingService } from "./memory-embeddings";
import { MemoryProviders } from "./memory-providers";
import { MemoryRecordRepository } from "./memory-records";
import { MemorySupersessionService, SupersessionDecision } from "./memory-supersession";

export type GateMode = "off" | "shadow" | "active";
type GateDecision = { label: string; scope: string; confidence: number; records: Array<{ subject_key?: string; text: string; kind?: string }> };
export interface MemoryProposal { content: string; source: string; idempotencyKey: string; contentHash?: string; fact?: { uid: string; subject: string; relation: string; object: string } }
export interface MemoryProposalResult { status: "off" | "shadow" | "accepted" | "quarantined" | "ledger"; label?: string; record_ids?: string[]; reason?: string }

const KEEPERS = new Set(["authority", "decision", "lesson", "preference", "project_fact"]);
const LABELS = new Set([...KEEPERS, "receipt", "drop", "noise"]);
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const inFlight = new Map<string, { inputHash: string; promise: Promise<MemoryProposalResult> }>();
let activeQueue: Promise<void> = Promise.resolve();

export function parseGateMode(value: string | undefined): GateMode {
  return value === "active" || value === "shadow" ? value : "off";
}

export class MemoryGateService {
  private readonly db: Database.Database;
  private readonly providers: Pick<MemoryProviders, "callMimo" | "callLuna" | "callSol">;
  private readonly prefilter: Set<string>;
  private readonly mode: GateMode;
  private readonly embed: (text: string) => Promise<number[]>;
  private readonly repository: MemoryRecordRepository;

  constructor(options: { db?: Database.Database; providers?: any; prefilter?: Set<string>; mode?: GateMode; embed?: (text: string) => Promise<number[]> } = {}) {
    this.db = options.db ?? getSqlite();
    this.providers = options.providers ?? new MemoryProviders({ budget: new MemoryBudget(this.db) });
    this.prefilter = options.prefilter ?? this.loadPrefilter();
    this.mode = options.mode ?? parseGateMode(process.env.ARCRIFT_MEMORY_WRITE_MODE);
    this.embed = options.embed ?? (text => new MemoryEmbeddingService().embed(text));
    this.repository = new MemoryRecordRepository(this.db);
  }

  async propose(input: MemoryProposal): Promise<MemoryProposalResult> {
    if (!input.content || !input.source || !input.idempotencyKey) throw new Error("content, source, and idempotencyKey are required");
    if (Buffer.byteLength(input.content, "utf8") > 32_000 || input.source.length > 128 || input.idempotencyKey.length > 256) throw new Error("memory proposal exceeds size limits");
    const inputHash = hash(JSON.stringify({ content: input.content, source: input.source, fact: input.fact ?? null }));
    const active = inFlight.get(input.idempotencyKey);
    if (active) {
      if (active.inputHash !== inputHash) throw new Error("Idempotency key reused with different input");
      return active.promise;
    }
    const execute = () => this.proposeClaimed(input, inputHash);
    const promise = (this.mode === "active" ? activeQueue.then(execute) : execute()).finally(() => {
      if (inFlight.get(input.idempotencyKey)?.promise === promise) inFlight.delete(input.idempotencyKey);
    });
    if (this.mode === "active") activeQueue = promise.then(() => undefined, () => undefined);
    inFlight.set(input.idempotencyKey, { inputHash, promise });
    return promise;
  }

  private async proposeClaimed(input: MemoryProposal, inputHash: string): Promise<MemoryProposalResult> {
    const existing = this.db.prepare("SELECT input_hash, result_json, status, updated_at FROM memory_proposals WHERE idempotency_key=?").get(input.idempotencyKey) as any;
    if (existing) {
      if (existing.input_hash !== inputHash) throw new Error("Idempotency key reused with different input");
      const result = JSON.parse(existing.result_json);
      if (existing.status !== "pending") return result;
      if (Date.now() - Date.parse(existing.updated_at) < 10 * 60_000) throw new Error("Proposal is already processing");
      this.db.prepare("UPDATE memory_proposals SET updated_at=? WHERE idempotency_key=? AND status='pending'").run(new Date().toISOString(), input.idempotencyKey);
    } else {
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO memory_proposals(idempotency_key,input_hash,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run(input.idempotencyKey, inputHash, "pending", JSON.stringify({ status: "pending" }), now, now);
    }
    if (this.mode === "off") return this.save(input.idempotencyKey, inputHash, { status: "off" });

    if (input.source === "arcrift-fact") {
      if (!input.fact?.uid || !input.fact.subject || !input.fact.relation || !input.fact.object) return this.quarantine(input, inputHash, "invalid_fact");
      if (this.prefilter.has(input.fact.relation)) return this.quarantine(input, inputHash, "relation_prefilter");
    }

    try {
      const prompt = this.triagePrompt(input);
      const mimo = this.validateDecision((await this.providers.callMimo(prompt)).value);
      if (input.source !== "arcrift-fact") {
        let decision: GateDecision;
        try {
          const luna = this.validateDecision(await this.providers.callLuna(prompt));
          decision = this.sameDecision(mimo, luna) ? mimo : this.validateDecision(await this.providers.callSol(prompt));
        } catch (error) {
          if (this.mode === "shadow") {
            return this.save(input.idempotencyKey, inputHash, {
              status: "shadow",
              label: mimo.label,
              reason: `second_opinion_unavailable:${error instanceof Error ? error.message : String(error)}`,
            });
          }
          throw error;
        }
        return await this.applyDecision(input, inputHash, decision);
      }
      return await this.applyDecision(input, inputHash, mimo);
    } catch (error) {
      return this.quarantine(input, inputHash, `provider_failure:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async applyDecision(input: MemoryProposal, inputHash: string, decision: GateDecision): Promise<MemoryProposalResult> {
    if (decision.label === "receipt") {
      const uid = input.fact?.uid ?? `proposal:${hash(input.idempotencyKey)}`;
      const result: MemoryProposalResult = { status: "ledger", label: "receipt" };
      return this.repository.transaction(() => {
        this.repository.addLedger(uid, "receipt", { source: input.source, content_hash: input.contentHash ?? hash(input.content) });
        return this.save(input.idempotencyKey, inputHash, result);
      });
    }
    if (!KEEPERS.has(decision.label) || decision.records.length === 0) return this.quarantine(input, inputHash, `gate:${decision.label}`);
    if (this.mode === "shadow") return this.save(input.idempotencyKey, inputHash, { status: "shadow", label: decision.label });

    const uid = `proposal:${hash(input.idempotencyKey)}`;
    const prepared: Array<{ record: any; embedding: number[]; plan: any }> = [];
    for (let index = 0; index < decision.records.length; index++) {
      const proposed = decision.records[index];
      const rid = `${uid}#${index}`;
      const embedding = await this.embed(proposed.text);
      const supersession = new MemorySupersessionService(this.db, (oldRecord, newRecord, similarity) => this.adjudicate(oldRecord.text, newRecord.text, similarity));
      const record = { rid, uid, source: input.source, at: new Date().toISOString(), kind: proposed.kind ?? decision.label, scope: decision.scope, subject_key: proposed.subject_key ?? null, text: proposed.text, sigma: String(decision.confidence), status: "current" as const };
      const plan = await supersession.planCandidate(record, embedding, prepared);
      prepared.push({ record, embedding, plan });
    }
    const result: MemoryProposalResult = { status: "accepted", label: decision.label, record_ids: prepared.map(item => item.record.rid) };
    return this.repository.transaction(() => {
      this.repository.upsertSource({ uid, source: input.source, at: new Date().toISOString(), text: input.content });
      for (const item of prepared) {
        const supersession = new MemorySupersessionService(this.db, () => { throw new Error("adjudication must be staged before commit"); });
        supersession.applyPlan(item.record, item.embedding, item.plan);
      }
      return this.save(input.idempotencyKey, inputHash, result);
    });
  }

  private async adjudicate(oldText: string, newText: string, similarity: number | null): Promise<SupersessionDecision> {
    const prompt = `Classify the relationship as same, newer, older, conflict, or unrelated. Return {"decision":"..."}.\nOLD: ${oldText}\nNEW: ${newText}\nSIMILARITY: ${similarity ?? "subject-key"}`;
    const valid = (value: any): SupersessionDecision => {
      const decision = value?.decision as SupersessionDecision;
      if (!["same", "newer", "older", "conflict", "unrelated"].includes(decision)) throw new Error("invalid supersession decision");
      return decision;
    };
    const mimo = valid((await this.providers.callMimo(prompt)).value);
    const luna = valid(await this.providers.callLuna(prompt));
    if (mimo === luna) return mimo;
    return valid(await this.providers.callSol(prompt));
  }

  private validateDecision(value: any): GateDecision {
    if (!value || !LABELS.has(value.label) || typeof value.scope !== "string" || !Array.isArray(value.records) || value.records.length > 4) throw new Error("invalid gate decision");
    const confidence = Number(value.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("invalid gate confidence");
    if (KEEPERS.has(value.label) && !["global", "project"].includes(value.scope)) throw new Error("invalid gate scope");
    if (!KEEPERS.has(value.label) && (value.scope !== "-" || value.records.length !== 0)) throw new Error("invalid non-memory gate result");
    for (const record of value.records) {
      if (!record || typeof record.text !== "string" || !record.text.trim() || record.text.length > 4_000) throw new Error("invalid gate record");
      if (record.subject_key != null && (typeof record.subject_key !== "string" || record.subject_key.length > 256)) throw new Error("invalid subject key");
    }
    return { label: value.label, scope: value.scope, confidence, records: value.records };
  }

  private sameDecision(a: GateDecision, b: GateDecision): boolean {
    return a.label === b.label && a.scope === b.scope && JSON.stringify(a.records) === JSON.stringify(b.records);
  }

  private triagePrompt(input: MemoryProposal): string {
    return `Classify durable memory. Return JSON {label,scope,confidence,records:[{subject_key,text}]}. Source=${input.source}. Content:\n${input.content}`;
  }

  private quarantine(input: MemoryProposal, inputHash: string, reason: string): MemoryProposalResult {
    return this.repository.transaction(() => {
      this.repository.addQuarantine(input.fact?.uid ?? `proposal:${hash(input.idempotencyKey)}`, reason, input.source);
      return this.save(input.idempotencyKey, inputHash, { status: "quarantined", reason });
    });
  }

  private save(key: string, inputHash: string, result: MemoryProposalResult): MemoryProposalResult {
    const now = new Date().toISOString();
    const updated = this.db.prepare("UPDATE memory_proposals SET status=?,result_json=?,updated_at=? WHERE idempotency_key=? AND input_hash=?")
      .run(result.status, JSON.stringify(result), now, key, inputHash);
    if (updated.changes !== 1) throw new Error("Proposal claim was lost");
    return result;
  }

  private loadPrefilter(): Set<string> {
    const file = process.env.ARCRIFT_MEMORY_PREFILTER_PATH ?? path.resolve(process.cwd(), "config/memory-relation-prefilter-v1.json");
    if (!fs.existsSync(file)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set((parsed.relations ?? []).map((entry: any) => String(entry.relation)));
  }
}
