import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MemoryGateService } from "../../src/services/memory-gate";
import { parseGateMode } from "../../src/services/memory-gate";
import { MemoryRecordRepository } from "../../src/services/memory-records";

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

  it("records a non-writing shadow result when the second opinion is unavailable", async () => {
    const providers = {
      callMimo: jest.fn(async () => ({ value: keeper, cost: 0, requestHash: "m" })),
      callLuna: jest.fn(async () => { throw new Error("Pi provider timed out"); }),
      callSol: jest.fn(async () => keeper),
    };
    const gate = new MemoryGateService({ db: getSqlite(), providers: providers as any, prefilter: new Set(), mode: "shadow" });
    const result = await gate.propose({ content: "decision", source: "agent-zero", idempotencyKey: "shadow-timeout" });
    expect(result).toEqual({ status: "shadow", label: "decision", reason: "second_opinion_unavailable:Pi provider timed out" });
    expect(providers.callSol).not.toHaveBeenCalled();
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_records").get() as any).n).toBe(0);
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_proposals").get() as any).n).toBe(1);
  });

  it("fails invalid write modes closed", () => {
    expect(parseGateMode("active")).toBe("active");
    expect(parseGateMode("shadow")).toBe("shadow");
    expect(parseGateMode("typo-active")).toBe("off");
    expect(parseGateMode(undefined)).toBe("off");
  });

  it("coalesces overlapping idempotent proposals", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const providers = {
      callMimo: jest.fn(async () => { await blocked; return { value: keeper, cost: 0, requestHash: "m" }; }),
      callLuna: jest.fn(async () => keeper),
      callSol: jest.fn(async () => keeper),
    };
    const first = new MemoryGateService({ db: getSqlite(), providers, mode: "shadow" }).propose({ content: "decision", source: "a0", idempotencyKey: "overlap" });
    const second = new MemoryGateService({ db: getSqlite(), providers, mode: "shadow" }).propose({ content: "decision", source: "a0", idempotencyKey: "overlap" });
    release();
    expect(await second).toEqual(await first);
    expect(providers.callMimo).toHaveBeenCalledTimes(1);
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_proposals").get() as any).n).toBe(1);
  });

  it("requires two supersession votes and validates gate output", async () => {
    const { gate, providers } = service();
    await expect(gate.propose({ content: "decision", source: "a0", idempotencyKey: "strict" })).resolves.toMatchObject({ status: "accepted" });
    providers.callMimo.mockResolvedValueOnce({ value: { ...keeper, confidence: 2 }, cost: 0, requestHash: "bad" });
    await expect(gate.propose({ content: "bad", source: "a0", idempotencyKey: "invalid-schema" })).resolves.toMatchObject({ status: "quarantined" });
  });

  it("uses two supersession votes and Sol as the tiebreak", async () => {
    const repository = new MemoryRecordRepository(getSqlite());
    repository.upsertSource({ uid: "old-source", source: "fixture", text: "old source" });
    repository.insertRecord({ rid: "old", uid: "old-source", source: "fixture", kind: "decision", scope: "global", subject_key: "git.rule", text: "Old rule", status: "current" });
    repository.upsertEmbedding("old", new Array(1024).fill(0.1));
    const providers = {
      callMimo: jest.fn()
        .mockResolvedValueOnce({ value: keeper, cost: 0, requestHash: "triage" })
        .mockResolvedValueOnce({ value: { decision: "newer" }, cost: 0, requestHash: "pair" }),
      callLuna: jest.fn()
        .mockResolvedValueOnce(keeper)
        .mockResolvedValueOnce({ decision: "older" }),
      callSol: jest.fn().mockResolvedValue({ decision: "conflict" }),
    };
    const gate = new MemoryGateService({ db: getSqlite(), providers, mode: "active", embed: async () => new Array(1024).fill(0.2) });
    expect((await gate.propose({ content: "new", source: "a0", idempotencyKey: "vote" })).status).toBe("accepted");
    expect(providers.callSol).toHaveBeenCalledTimes(1);
    expect((getSqlite().prepare("SELECT status FROM memory_records WHERE rid LIKE 'proposal:%#0'").get() as any).status).toBe("disputed");
  });

  it("does not partially write an active multi-record proposal", async () => {
    const multi = { ...keeper, records: [keeper.records[0], { subject_key: "other", text: "Second record" }] };
    const providers = { callMimo: async () => ({ value: multi, cost: 0, requestHash: "m" }), callLuna: async () => multi, callSol: async () => multi };
    let calls = 0;
    const gate = new MemoryGateService({
      db: getSqlite(), providers, mode: "active",
      embed: async () => { calls += 1; if (calls === 2) throw new Error("embedding failed"); return new Array(1024).fill(0.1); },
    });
    expect((await gate.propose({ content: "multi", source: "a0", idempotencyKey: "atomic" })).status).toBe("quarantined");
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_sources WHERE uid LIKE 'proposal:%'").get() as any).n).toBe(0);
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_records").get() as any).n).toBe(0);
  });

  it("plans later records against earlier records in the same active proposal", async () => {
    const multi = { ...keeper, records: [
      { subject_key: "shared", text: "First rule" },
      { subject_key: "shared", text: "New rule" },
    ] };
    const providers = {
      callMimo: jest.fn()
        .mockResolvedValueOnce({ value: multi, cost: 0, requestHash: "triage" })
        .mockResolvedValueOnce({ value: { decision: "newer" }, cost: 0, requestHash: "pair" }),
      callLuna: jest.fn()
        .mockResolvedValueOnce(multi)
        .mockResolvedValueOnce({ decision: "newer" }),
      callSol: jest.fn(),
    };
    const gate = new MemoryGateService({ db: getSqlite(), providers, mode: "active", embed: async text => new Array(1024).fill(text.startsWith("First") ? 0.1 : 0.2) });
    const result = await gate.propose({ content: "two versions", source: "a0", idempotencyKey: "staged" });
    expect(result.status).toBe("accepted");
    const rows = getSqlite().prepare("SELECT rid,status,superseded_by FROM memory_records ORDER BY rid").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "superseded", superseded_by: rows[1].rid });
    expect(rows[1].status).toBe("current");
  });
});
