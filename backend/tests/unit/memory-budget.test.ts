import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MemoryBudget } from "../../src/services/memory-budget";

describe("CT-day memory budget", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-budget-"));
    process.env.SQLITE_DB_PATH = path.join(root, "budget.sqlite");
    initSqlite();
  });
  afterEach(() => { getSqlite().close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("uses America/Chicago dates across UTC midnight", () => {
    const budget = new MemoryBudget(getSqlite());
    expect(budget.ctDate(new Date("2026-09-28T00:30:00Z"))).toBe("2026-09-27");
  });

  it("records cost idempotently, warns once, and holds before 0.95", () => {
    const budget = new MemoryBudget(getSqlite(), { now: () => new Date("2026-09-27T18:00:00Z") });
    budget.record("openrouter", "mimo", 0.76, "r1");
    budget.record("openrouter", "mimo", 0.76, "r1");
    expect(budget.status()).toMatchObject({ total: 0.76, warn: true, warn_now: true, hold: false });
    expect(budget.status().warn_now).toBe(false);
    expect(budget.canStart(0.18)).toBe(true);
    expect(budget.canStart(0.20)).toBe(false);
    budget.record("openrouter", "mimo", 0.19, "r2");
    expect(budget.status().hold).toBe(true);
  });
});
