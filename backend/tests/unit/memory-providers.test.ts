import { MemoryProviders } from "../../src/services/memory-providers";

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
});
