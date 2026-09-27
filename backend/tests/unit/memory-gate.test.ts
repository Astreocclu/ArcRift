import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MemoryGateService } from "../../src/services/memory-gate";

describe("curated memory write gate", () => {
  let root: string;
  const keeper = { label: "decision", scope: "global", confidence: 0.9, records: [{ subject_key: "git.rule", text: "Keep Git mechanics agent-owned." }] };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-gate-"));
    process.env.SQLITE_DB_PATH = path.join(root, "db.sqlite");
    initSqlite();
  });
  afterEach(() => { getSqlite().close(); fs.rmSync(root, { recursive: true, force: true }); });

  function service(overrides: any = {}) {
    const providers = {
      callMimo: jest.fn(async () => ({ value: keeper, cost: 0, requestHash: "m" })),
      callLuna: jest.fn(async () => keeper),
      callSol: jest.fn(async () => keeper),
      ...overrides,
    };
    return { providers, gate: new MemoryGateService({ db: getSqlite(), providers: providers as any, prefilter: new Set(["NOISE"]), mode: "active", embed: async () => new Array(1024).fill(0.1) }) };
  }

  it("routes prefiltered facts and receipts without semantic writes", async () => {
    const { gate, providers } = service();
    const dropped = await gate.propose({ content: "s r o", source: "arcrift-fact", idempotencyKey: "drop", fact: { uid: "af:1", subject: "s", relation: "NOISE", object: "o" } });
    expect(dropped.status).toBe("quarantined");
    expect(providers.callMimo).not.toHaveBeenCalled();

    providers.callMimo.mockResolvedValueOnce({ value: { label: "receipt", scope: "-", confidence: 1, records: [] }, cost: 0, requestHash: "r" });
    const receipt = await gate.propose({ content: "completed build", source: "arcrift-fact", idempotencyKey: "receipt", fact: { uid: "af:2", subject: "build", relation: "COMPLETED_AT", object: "time" } });
    expect(receipt.status).toBe("ledger");
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_ledger").get() as any).n).toBe(1);
  });

  it("uses two-model agreement and Sol only for disagreement", async () => {
    const { gate, providers } = service();
    expect((await gate.propose({ content: "decision", source: "a0", idempotencyKey: "agree" })).status).toBe("accepted");
    expect(providers.callSol).not.toHaveBeenCalled();

    providers.callLuna.mockResolvedValueOnce({ label: "drop", scope: "-", confidence: 0.8, records: [] });
    providers.callSol.mockResolvedValueOnce(keeper);
    expect((await gate.propose({ content: "another decision", source: "claude", idempotencyKey: "split" })).status).toBe("accepted");
    expect(providers.callSol).toHaveBeenCalledTimes(1);
  });

  it("is idempotent, validates strict facts, and fails closed on provider errors", async () => {
    const { gate, providers } = service();
    expect((await gate.propose({ content: "bad fact", source: "arcrift-fact", idempotencyKey: "bad" })).status).toBe("quarantined");
    const first = await gate.propose({ content: "decision", source: "a0", idempotencyKey: "same" });
    const second = await gate.propose({ content: "decision", source: "a0", idempotencyKey: "same" });
    expect(second).toEqual(first);
    providers.callMimo.mockRejectedValueOnce(new Error("offline"));
    expect((await gate.propose({ content: "uncertain", source: "a0", idempotencyKey: "failure" })).status).toBe("quarantined");
  });

  it("records decisions but does not write records in shadow mode", async () => {
    const providers = { callMimo: async () => ({ value: keeper, cost: 0, requestHash: "m" }), callLuna: async () => keeper, callSol: async () => keeper };
    const gate = new MemoryGateService({ db: getSqlite(), providers: providers as any, prefilter: new Set(), mode: "shadow", embed: async () => new Array(1024).fill(0.1) });
    expect((await gate.propose({ content: "decision", source: "a0", idempotencyKey: "shadow" })).status).toBe("shadow");
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_records").get() as any).n).toBe(0);
  });
});
