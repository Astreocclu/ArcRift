import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MemoryBudget } from "../../src/services/memory-budget";
import { MIMO_ATTEMPT_RESERVATION_USD, MIMO_WORST_CASE_USD, MemoryProviders } from "../../src/services/memory-providers";

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
    expect(calls[0].body.provider).toEqual({ allow_fallbacks: false, max_price: { prompt: 0.5, completion: 1 } });
    expect(MIMO_WORST_CASE_USD).toBeLessThan(MIMO_ATTEMPT_RESERVATION_USD);
    expect(result.value.label).toBe("drop");
    expect(result.cost).toBe(0.0123);
  });

  it("uses explicit Luna and Sol Pi routes with no fallback", async () => {
    const invocations: any[] = [];
    const providers = new MemoryProviders({
      openRouterKey: "test-key",
      httpPost: async () => { throw new Error("unused"); },
      execPi: async (model, promptPath) => { invocations.push({ model, promptPath }); return '```json\n{"decision":"conflict"}\n```'; },
    });
    expect((await providers.callLuna("x")).decision).toBe("conflict");
    expect((await providers.callSol("x")).decision).toBe("conflict");
    expect(invocations.map(item => item.model)).toEqual(["openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol"]);
  });

  it("rejects malformed model JSON and retry exhaustion", async () => {
    const providers = new MemoryProviders({ openRouterKey: "test", httpPost: async () => ({ data: { choices: [{ message: { content: "not-json" } }], usage: { cost: 0 } } }), execPi: async () => "not-json", retries: 1 });
    await expect(providers.callMimo("x")).rejects.toThrow(/JSON/);
    await expect(providers.callLuna("x")).rejects.toThrow(/JSON/);
  });

  it("bounds stalled Pi calls without retry amplification", async () => {
    const invocations: string[] = [];
    const providers = new MemoryProviders({
      execPi: async model => {
        invocations.push(model);
        return await new Promise<string>(() => undefined);
      },
      piRetries: 0,
      piTimeoutMs: 10,
    });
    await expect(providers.callLuna("x")).rejects.toThrow(/timed out/);
    expect(invocations).toEqual(["openai-codex/gpt-6-luna"]);
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
