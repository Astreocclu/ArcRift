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

type GateMode = "off" | "shadow" | "active";
type GateDecision = { label: string; scope: string; confidence: number; records: Array<{ subject_key?: string; text: string; kind?: string }> };
export interface MemoryProposal { content: string; source: string; idempotencyKey: string; contentHash?: string; fact?: { uid: string; subject: string; relation: string; object: string } }
export interface MemoryProposalResult { status: "off" | "shadow" | "accepted" | "quarantined" | "ledger"; label?: string; record_ids?: string[]; reason?: string }

const KEEPERS = new Set(["authority", "decision", "lesson", "preference", "project_fact"]);
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

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
    this.mode = options.mode ?? (process.env.ARCRIFT_MEMORY_WRITE_MODE as GateMode | undefined) ?? "off";
    this.embed = options.embed ?? (text => new MemoryEmbeddingService().embed(text));
    this.repository = new MemoryRecordRepository(this.db);
  }

  async propose(input: MemoryProposal): Promise<MemoryProposalResult> {
    if (!input.content || !input.source || !input.idempotencyKey) throw new Error("content, source, and idempotencyKey are required");
    const inputHash = hash(JSON.stringify({ content: input.content, source: input.source, fact: input.fact ?? null }));
    const existing = this.db.prepare("SELECT input_hash, result_json FROM memory_proposals WHERE idempotency_key=?").get(input.idempotencyKey) as any;
    if (existing) {
      if (existing.input_hash !== inputHash) throw new Error("Idempotency key reused with different input");
      return JSON.parse(existing.result_json);
    }
    if (this.mode === "off") return this.save(input.idempotencyKey, inputHash, { status: "off" });

    if (input.source === "arcrift-fact") {
      if (!input.fact?.uid || !input.fact.subject || !input.fact.relation || !input.fact.object) return this.quarantine(input, inputHash, "invalid_fact");
      if (this.prefilter.has(input.fact.relation)) return this.quarantine(input, inputHash, "relation_prefilter");
    }

    let decision: GateDecision;
    try {
      const prompt = this.triagePrompt(input);
      const mimo = this.validateDecision((await this.providers.callMimo(prompt)).value);
      if (input.source === "arcrift-fact") decision = mimo;
      else {
        const luna = this.validateDecision(await this.providers.callLuna(prompt));
        decision = this.sameDecision(mimo, luna) ? mimo : this.validateDecision(await this.providers.callSol(prompt));
      }
    } catch (error) {
      return this.quarantine(input, inputHash, `provider_failure:${error instanceof Error ? error.message : String(error)}`);
    }
    if (decision.label === "receipt") {
      const uid = input.fact?.uid ?? `proposal:${hash(input.idempotencyKey)}`;
      this.repository.addLedger(uid, "receipt", { source: input.source, content_hash: input.contentHash ?? hash(input.content) });
      return this.save(input.idempotencyKey, inputHash, { status: "ledger", label: "receipt" });
    }
    if (!KEEPERS.has(decision.label) || decision.records.length === 0) return this.quarantine(input, inputHash, `gate:${decision.label}`);
    if (this.mode === "shadow") return this.save(input.idempotencyKey, inputHash, { status: "shadow", label: decision.label });

    const uid = `proposal:${hash(input.idempotencyKey)}`;
    this.repository.upsertSource({ uid, source: input.source, at: new Date().toISOString(), text: input.content });
    const recordIds: string[] = [];
    for (let index = 0; index < decision.records.length; index++) {
      const proposed = decision.records[index];
      const rid = `${uid}#${index}`;
      const embedding = await this.embed(proposed.text);
      const supersession = new MemorySupersessionService(this.db, (oldRecord, newRecord, similarity) => this.adjudicate(oldRecord.text, newRecord.text, similarity));
      await supersession.applyCandidate({ rid, uid, source: input.source, at: new Date().toISOString(), kind: proposed.kind ?? decision.label, scope: decision.scope, subject_key: proposed.subject_key ?? null, text: proposed.text, sigma: String(decision.confidence), status: "current" }, embedding);
      recordIds.push(rid);
    }
    return this.save(input.idempotencyKey, inputHash, { status: "accepted", label: decision.label, record_ids: recordIds });
  }

  private async adjudicate(oldText: string, newText: string, similarity: number | null): Promise<SupersessionDecision> {
    const prompt = `Classify the relationship as same, newer, older, conflict, or unrelated. Return {"decision":"..."}.\nOLD: ${oldText}\nNEW: ${newText}\nSIMILARITY: ${similarity ?? "subject-key"}`;
    const mimo = (await this.providers.callMimo(prompt)).value?.decision as SupersessionDecision;
    if (!["same", "newer", "older", "conflict", "unrelated"].includes(mimo)) throw new Error("invalid supersession decision");
    if (mimo !== "conflict") return mimo;
    const luna = (await this.providers.callLuna(prompt)).decision as SupersessionDecision;
    if (luna === "conflict") return "conflict";
    const sol = (await this.providers.callSol(prompt)).decision as SupersessionDecision;
    return ["same", "newer", "older", "conflict", "unrelated"].includes(sol) ? sol : "conflict";
  }

  private validateDecision(value: any): GateDecision {
    if (!value || typeof value.label !== "string" || typeof value.scope !== "string" || !Array.isArray(value.records)) throw new Error("invalid gate decision");
    for (const record of value.records) if (!record || typeof record.text !== "string" || !record.text.trim()) throw new Error("invalid gate record");
    return { label: value.label, scope: value.scope, confidence: Number(value.confidence ?? 0), records: value.records };
  }

  private sameDecision(a: GateDecision, b: GateDecision): boolean {
    return a.label === b.label && a.scope === b.scope && JSON.stringify(a.records) === JSON.stringify(b.records);
  }

  private triagePrompt(input: MemoryProposal): string {
    return `Classify durable memory. Return JSON {label,scope,confidence,records:[{subject_key,text}]}. Source=${input.source}. Content:\n${input.content}`;
  }

  private quarantine(input: MemoryProposal, inputHash: string, reason: string): MemoryProposalResult {
    this.repository.addQuarantine(input.fact?.uid ?? `proposal:${hash(input.idempotencyKey)}`, reason, input.source);
    return this.save(input.idempotencyKey, inputHash, { status: "quarantined", reason });
  }

  private save(key: string, inputHash: string, result: MemoryProposalResult): MemoryProposalResult {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO memory_proposals(idempotency_key,input_hash,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(key, inputHash, result.status, JSON.stringify(result), now, now);
    return result;
  }

  private loadPrefilter(): Set<string> {
    const file = process.env.ARCRIFT_MEMORY_PREFILTER_PATH ?? path.resolve(process.cwd(), "config/memory-relation-prefilter-v1.json");
    if (!fs.existsSync(file)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set((parsed.relations ?? []).map((entry: any) => String(entry.relation)));
  }
}
