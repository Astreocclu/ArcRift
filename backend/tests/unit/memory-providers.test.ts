import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MemoryBudget } from "../../src/services/memory-budget";
import {
  MIMO_ATTEMPT_RESERVATION_USD,
  MIMO_LOW_REASONING_SHARE,
  MIMO_MAX_DECISION_TOKENS,
  MIMO_MAX_TOKENS,
  MIMO_REASONING_TOKEN_RESERVE,
  MIMO_WORST_CASE_USD,
  MemoryProviderError,
  MemoryProviders,
} from "../../src/services/memory-providers";

describe("memory model providers", () => {
  it("calls MiMo with low reasoning and returns structured usage", async () => {
    const calls: any[] = [];
    const providers = new MemoryProviders({
      openRouterKey: "test-key",
      httpPost: async (_url, body, config) => {
        calls.push({ body, config });
        return { data: { choices: [{ message: { content: '{"label":"drop","scope":"-","confidence":0.9,"records":[]}' } }], usage: { cost: 0.0123 } } };
      },
      execPi: async () => "{}",
    });
    const result = await providers.callMimo("prompt");
    expect(calls[0].body.reasoning.effort).toBe("low");
    expect(calls[0].body.model).toBe("xiaomi/mimo-v2.6-pro");
    expect(calls[0].body.max_tokens).toBe(32_000);
    expect(calls[0].body.provider).toEqual({ allow_fallbacks: false, max_price: { prompt: 0.5, completion: 1 } });
    expect(MIMO_WORST_CASE_USD).toBeCloseTo(0.052, 6);
    expect(MIMO_WORST_CASE_USD).toBeLessThanOrEqual(MIMO_ATTEMPT_RESERVATION_USD);
    expect(result.value.label).toBe("drop");
    expect(result.rawReply).toContain('"label":"drop"');
    expect(result.cost).toBe(0.0123);
  });

  it("fits a maximum production decision plus reasoning reserve under the cap", () => {
    const decision = JSON.stringify({
      label: "project_fact",
      scope: "project",
      confidence: 1,
      records: Array.from({ length: 4 }, () => ({ subject_key: "s".repeat(256), text: "x".repeat(4_000) })),
    });
    expect(MIMO_LOW_REASONING_SHARE).toBe(0.2);
    expect(MIMO_REASONING_TOKEN_RESERVE).toBe(Math.ceil(MIMO_MAX_TOKENS * MIMO_LOW_REASONING_SHARE));
    expect(MIMO_MAX_DECISION_TOKENS).toBe(MIMO_MAX_TOKENS - MIMO_REASONING_TOKEN_RESERVE);
    expect(decision.length).toBeLessThanOrEqual(MIMO_MAX_DECISION_TOKENS);
    expect(MIMO_MAX_DECISION_TOKENS + MIMO_REASONING_TOKEN_RESERVE).toBeLessThanOrEqual(MIMO_MAX_TOKENS);
  });

  it("rejects malformed model JSON and retry exhaustion", async () => {
    const providers = new MemoryProviders({ openRouterKey: "test", httpPost: async () => ({ data: { choices: [{ message: { content: "not-json" } }], usage: { cost: 0 } } }), retries: 1 });
    const error = await providers.callMimo("x").catch(value => value);
    expect(error).toBeInstanceOf(MemoryProviderError);
    expect(error.message).toMatch(/JSON/);
    expect(error.rawReply).toBe("not-json");
  });

  it("reserves every MiMo attempt and accounts for malformed billable replies", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-provider-budget-"));
    process.env.SQLITE_DB_PATH = path.join(root, "db.sqlite");
    initSqlite();
    let attempts = 0;
    const providers = new MemoryProviders({
      openRouterKey: "test",
      budget: new MemoryBudget(getSqlite()),
      retries: 1,
      httpPost: async (_url, body) => {
        expect(body.max_tokens).toBeGreaterThan(0);
        attempts += 1;
        return { data: { choices: [{ message: { content: attempts === 1 ? "bad-json" : '{"label":"drop","scope":"-","confidence":0.9,"records":[]}' } }], usage: { cost: 0.01 } } };
      },
    });
    await expect(providers.callMimo("bounded prompt")).resolves.toMatchObject({ cost: 0.01 });
    expect((getSqlite().prepare("SELECT sum(cost_usd) AS total FROM memory_usage").get() as any).total).toBeCloseTo(0.02);
    await expect(providers.callMimo("bounded prompt")).resolves.toMatchObject({ cost: 0.01 });
    expect((getSqlite().prepare("SELECT sum(cost_usd) AS total FROM memory_usage").get() as any).total).toBeCloseTo(0.03);
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_budget_reservations").get() as any).n).toBe(0);
    getSqlite().close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
