import Database from "better-sqlite3";
import { getSqlite } from "./sqlite";
import { MemoryRecordRepository } from "./memory-records";
import { MemoryEmbeddingService } from "./memory-embeddings";
import { MEMORY_KERNEL } from "./memory-kernel";

export interface FusedRanking {
  rid: string;
  score: number;
}

export function fuseRankings(fts: string[], vectors: string[], rrfK = 60): FusedRanking[] {
  const scores = new Map<string, number>();
  for (const ranking of [fts, vectors]) {
    ranking.forEach((rid, index) => scores.set(rid, (scores.get(rid) ?? 0) + 1 / (rrfK + index + 1)));
  }
  return [...scores.entries()]
    .map(([rid, score]) => ({ rid, score }))
    .sort((a, b) => b.score - a.score || a.rid.localeCompare(b.rid));
}

export interface MemorySearchRecord {
  rid: string;
  matched_rids: string[];
  uid: string;
  source: string;
  at: string | null;
  kind: string;
  scope: string;
  subject_key: string | null;
  text: string;
  status: string;
  score: number;
  source_text: string;
}

export interface MemorySearchResult {
  query: string;
  records: MemorySearchRecord[];
  text: string;
}

export class MemorySearchService {
  private readonly db: Database.Database;
  private readonly embed: (text: string) => Promise<number[]>;
  private readonly repository: MemoryRecordRepository;
  private readonly kernelEnabled: boolean;

  constructor(options: { db?: Database.Database; embed?: (text: string) => Promise<number[]>; kernelEnabled?: boolean } = {}) {
    this.db = options.db ?? getSqlite();
    this.embed = options.embed ?? (text => new MemoryEmbeddingService().embed(text));
    this.repository = new MemoryRecordRepository(this.db);
    this.kernelEnabled = options.kernelEnabled ?? process.env.ARCRIFT_MEMORY_KERNEL_ENABLED === "true";
  }

  async search(query: string, options: { topN?: number; sourceChars?: number; outputChars?: number } = {}): Promise<MemorySearchResult> {
    const topN = Math.max(1, Math.min(options.topN ?? 8, 8));
    const sourceChars = Math.max(0, Math.min(options.sourceChars ?? 600, 600));
    const outputChars = Math.max(this.kernelEnabled ? MEMORY_KERNEL.length : 1, Math.min(options.outputChars ?? 8000, 8000));
    const ftsRids = this.searchFts(query, 50);
    const embedding = await this.embed(query);
    if (embedding.length !== 1024 || embedding.some(value => !Number.isFinite(value))) {
      throw new Error(`Query embedding must contain exactly 1024 finite values; received ${embedding.length}`);
    }
    const vectorRids = this.searchVectors(embedding, 50);
    const fused = fuseRankings(ftsRids, vectorRids);

    const byHead = new Map<string, { score: number; matched: string[] }>();
    for (const candidate of fused) {
      const resolution = this.repository.resolveHead(candidate.rid);
      if (resolution.cycle || resolution.truncated) continue;
      const current = byHead.get(resolution.rid);
      if (current) {
        current.score = Math.max(current.score, candidate.score);
        current.matched.push(candidate.rid);
      } else {
        byHead.set(resolution.rid, { score: candidate.score, matched: [candidate.rid] });
      }
    }

    const heads = [...byHead.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
      .slice(0, topN);
    const records: MemorySearchRecord[] = [];
    const select = this.db.prepare(`
      SELECT r.rid, r.uid, r.source, r.at, r.kind, r.scope, r.subject_key,
             r.text, r.status, s.text AS source_text
      FROM memory_records r JOIN memory_sources s ON s.uid = r.uid
      WHERE r.rid = ?
    `);
    for (const [rid, ranking] of heads) {
      const row = select.get(rid) as Omit<MemorySearchRecord, "score" | "matched_rids"> | undefined;
      if (!row) continue;
      records.push({
        ...row,
        matched_rids: [...new Set(ranking.matched)],
        score: ranking.score,
        source_text: row.source_text.slice(0, sourceChars),
      });
    }

    const sections = records.map(record => [
      `[${record.kind}, ${record.scope}, ${record.status}, ${record.at ?? "undated"}] ${record.text}`,
      `source (${record.uid}): ${record.source_text}`,
    ].join("\n"));
    const body = sections.join("\n\n");
    const text = (this.kernelEnabled ? `${MEMORY_KERNEL}\n\n${body}` : body).slice(0, outputChars);
    return { query, records, text };
  }

  private searchFts(query: string, limit: number): string[] {
    const tokens = query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
    if (tokens.length === 0) return [];
    const ftsQuery = [...new Set(tokens)].map(token => `${token.replace(/"/g, "")}*`).join(" OR ");
    return (this.db.prepare(`
      SELECT rid FROM memory_record_fts
      WHERE memory_record_fts MATCH ?
      ORDER BY bm25(memory_record_fts), rid
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{ rid: string }>).map(row => row.rid);
  }

  private searchVectors(embedding: number[], limit: number): string[] {
    const vector = Buffer.from(new Float32Array(embedding).buffer);
    return (this.db.prepare(`
      SELECT record_id, distance FROM vec_memory_records
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(vector, limit) as Array<{ record_id: string; distance: number }>)
      .sort((a, b) => a.distance - b.distance || a.record_id.localeCompare(b.record_id))
      .map(row => row.record_id);
  }
}
