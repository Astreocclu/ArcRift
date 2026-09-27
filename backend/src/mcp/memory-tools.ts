import crypto from "crypto";
import { getSqlite } from "../services/sqlite";
import { MemoryRecordRepository } from "../services/memory-records";
import { MemorySearchService } from "../services/memory-search";

export type MemoryToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

export const MEMORY_TOOLS = [
  { name: "memory_search", description: "Search curated ArcRift records with all-version hybrid retrieval and source expansion.", inputSchema: { type: "object" as const, properties: { query: { type: "string" }, topN: { type: "number" } }, required: ["query"] } },
  { name: "memory_propose", description: "Submit a candidate exchange to the curated-memory gate.", inputSchema: { type: "object" as const, properties: { content: { type: "string" }, source: { type: "string" }, idempotencyKey: { type: "string" } }, required: ["content", "source", "idempotencyKey"] } },
  { name: "memory_conflicts", description: "List unresolved curated-memory conflicts.", inputSchema: { type: "object" as const, properties: { limit: { type: "number" } }, required: [] } },
  { name: "memory_resolve_conflict", description: "Record a decision for one curated-memory conflict.", inputSchema: { type: "object" as const, properties: { pairId: { type: "string" }, decision: { type: "string", enum: ["keep_old", "keep_new", "keep_both", "same"] }, decidedBy: { type: "string" }, note: { type: "string" } }, required: ["pairId", "decision", "decidedBy"] } },
];

export const handleMemoryTool: MemoryToolHandler = async (name, args) => {
  if (name === "memory_search") {
    if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query is required");
    return (await new MemorySearchService().search(args.query, { topN: typeof args.topN === "number" ? args.topN : undefined })).text;
  }
  if (name === "memory_conflicts") {
    const limit = Math.max(1, Math.min(typeof args.limit === "number" ? args.limit : 10, 50));
    return JSON.stringify(getSqlite().prepare(`
      SELECT p.*, old.text AS old_text, new.text AS new_text,
             old.subject_key AS old_subject_key, new.subject_key AS new_subject_key
      FROM memory_supersession_pairs p
      JOIN memory_records old ON old.rid = p.old_rid
      JOIN memory_records new ON new.rid = p.new_rid
      LEFT JOIN memory_conflict_decisions d ON d.pair_id = p.pair_id
      WHERE p.final = 'conflict' AND d.pair_id IS NULL
      ORDER BY p.pair_id LIMIT ?
    `).all(limit));
  }
  if (name === "memory_resolve_conflict") {
    if (typeof args.pairId !== "string" || typeof args.decidedBy !== "string") throw new Error("pairId and decidedBy are required");
    if (!["keep_old", "keep_new", "keep_both", "same"].includes(String(args.decision))) throw new Error("invalid conflict decision");
    new MemoryRecordRepository().decideConflict(args.pairId, args.decision as any, args.decidedBy, typeof args.note === "string" ? args.note : undefined);
    return JSON.stringify({ pair_id: args.pairId, decision: args.decision, saved: true });
  }
  if (name === "memory_propose") {
    if (typeof args.content !== "string" || typeof args.source !== "string" || typeof args.idempotencyKey !== "string") throw new Error("content, source, and idempotencyKey are required");
    if ((process.env.ARCRIFT_MEMORY_WRITE_MODE ?? "off") === "off") return JSON.stringify({ status: "off" });
    const { MemoryGateService } = require("../services/memory-gate") as { MemoryGateService: new () => { propose(input: any): Promise<unknown> } };
    return JSON.stringify(await new MemoryGateService().propose({ content: args.content, source: args.source, idempotencyKey: args.idempotencyKey, contentHash: crypto.createHash("sha256").update(args.content).digest("hex") }));
  }
  throw new Error(`Unknown memory tool: ${name}`);
};
