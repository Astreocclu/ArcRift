import Database from "better-sqlite3";
import { getSqlite } from "./sqlite";

export interface MemoryBudgetStatus {
  ct_date: string;
  total: number;
  warn: boolean;
  warn_now: boolean;
  hold: boolean;
}

export class MemoryBudget {
  private readonly now: () => Date;
  constructor(
    private readonly db: Database.Database = getSqlite(),
    options: { now?: () => Date; warning?: number; hold?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.warning = options.warning ?? 0.75;
    this.hold = options.hold ?? 0.95;
  }

  private readonly warning: number;
  private readonly hold: number;

  ctDate(date = this.now()): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date);
  }

  total(date = this.ctDate()): number {
    return Number((this.db.prepare("SELECT coalesce(sum(cost_usd), 0) AS total FROM memory_usage WHERE ct_date = ?").get(date) as any).total);
  }

  canStart(estimatedCost: number): boolean {
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0) return false;
    return this.total() + estimatedCost <= this.hold;
  }

  record(provider: string, model: string, costUsd: number, requestHash: string) {
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Memory provider cost must be a non-negative number");
    this.db.prepare(`
      INSERT OR IGNORE INTO memory_usage(ct_date, provider, model, cost_usd, request_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.ctDate(), provider, model, costUsd, requestHash, this.now().toISOString());
  }

  status(): MemoryBudgetStatus {
    const ctDate = this.ctDate();
    const total = this.total(ctDate);
    const warn = total >= this.warning;
    let warnNow = false;
    if (warn) {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO memory_usage_warnings(ct_date, warned_at) VALUES (?, ?)").run(ctDate, this.now().toISOString());
      warnNow = inserted.changes === 1;
    }
    return { ct_date: ctDate, total, warn, warn_now: warnNow, hold: total >= this.hold };
  }
}
