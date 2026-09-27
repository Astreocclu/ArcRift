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
  private readonly onWarning: (message: string) => void;
  constructor(
    private readonly db: Database.Database = getSqlite(),
    options: { now?: () => Date; warning?: number; hold?: number; onWarning?: (message: string) => void } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.warning = options.warning ?? 0.75;
    this.hold = options.hold ?? 0.95;
    this.onWarning = options.onWarning ?? (message => process.stderr.write(`${message}\n`));
  }

  private readonly warning: number;
  private readonly hold: number;

  ctDate(date = this.now()): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date);
  }

  total(date = this.ctDate()): number {
    const used = Number((this.db.prepare("SELECT coalesce(sum(cost_usd), 0) AS total FROM memory_usage WHERE ct_date = ?").get(date) as any).total);
    const reserved = Number((this.db.prepare("SELECT coalesce(sum(reserved_usd), 0) AS total FROM memory_budget_reservations WHERE ct_date = ?").get(date) as any).total);
    return used + reserved;
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
    this.status();
  }

  reserve(reservationId: string, provider: string, model: string, reservedUsd: number): boolean {
    if (!reservationId || !Number.isFinite(reservedUsd) || reservedUsd < 0) return false;
    const accepted = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT reservation_id FROM memory_budget_reservations WHERE reservation_id=?").get(reservationId);
      if (existing) return true;
      const date = this.ctDate();
      if (this.total(date) + reservedUsd > this.hold) return false;
      this.db.prepare(`
        INSERT INTO memory_budget_reservations(reservation_id,ct_date,provider,model,reserved_usd,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(reservationId, date, provider, model, reservedUsd, this.now().toISOString());
      return true;
    })();
    if (accepted) this.status();
    return accepted;
  }

  settle(reservationId: string, costUsd: number, requestHash: string): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Memory provider cost must be a non-negative number");
    this.db.transaction(() => {
      const reservation = this.db.prepare("SELECT * FROM memory_budget_reservations WHERE reservation_id=?").get(reservationId) as any;
      if (!reservation) throw new Error("Unknown memory budget reservation");
      this.db.prepare("DELETE FROM memory_budget_reservations WHERE reservation_id=?").run(reservationId);
      this.db.prepare(`
        INSERT OR IGNORE INTO memory_usage(ct_date,provider,model,cost_usd,request_hash,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(reservation.ct_date, reservation.provider, reservation.model, costUsd, requestHash, this.now().toISOString());
    })();
    this.status();
  }

  forfeit(reservationId: string): void {
    const reservation = this.db.prepare("SELECT * FROM memory_budget_reservations WHERE reservation_id=?").get(reservationId) as any;
    if (!reservation) return;
    this.settle(reservationId, reservation.reserved_usd, `unreported:${reservationId}`);
  }

  status(): MemoryBudgetStatus {
    const ctDate = this.ctDate();
    const total = this.total(ctDate);
    const warn = total >= this.warning;
    let warnNow = false;
    if (warn) {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO memory_usage_warnings(ct_date, warned_at) VALUES (?, ?)").run(ctDate, this.now().toISOString());
      warnNow = inserted.changes === 1;
      if (warnNow) this.onWarning(`[ArcRift memory] CT-day paid-call budget warning: $${total.toFixed(4)} accounted`);
    }
    return { ct_date: ctDate, total, warn, warn_now: warnNow, hold: total >= this.hold };
  }
}
