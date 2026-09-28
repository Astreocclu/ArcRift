import fs from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MEMORY_GATE_RUBRIC, MemoryGateService } from "../../src/services/memory-gate";
import { parseGateMode } from "../../src/services/memory-gate";
import { MIMO_MAX_INPUT_BYTES, MemoryProviderError } from "../../src/services/memory-providers";
import { MemoryRecordRepository } from "../../src/services/memory-records";

describe("curated memory write gate", () => {
  let root: string;
  const keeper = { label: "decision", scope: "global", confidence: 0.9, records: [{ subject_key: "git.rule", text: "Keep Git mechanics agent-owned." }] };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-gate-"));
    process.env.SQLITE_DB_PATH = path.join(root, "db.sqlite");
    process.env.ARCRIFT_MEMORY_GATE_FAILURE_DIR = path.join(root, "failures");
    initSqlite();
  });
  afterEach(() => { getSqlite().close(); delete process.env.ARCRIFT_MEMORY_GATE_FAILURE_DIR; fs.rmSync(root, { recursive: true, force: true }); });

  function service(overrides: any = {}) {
    const providers = {
      callMimo: jest.fn(async () => ({ value: keeper, cost: 0, requestHash: "m" })),
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

  it("uses exactly one MiMo call for triage", async () => {
    const { gate, providers } = service();
    expect((await gate.propose({ content: "decision", source: "a0", idempotencyKey: "agree" })).status).toBe("accepted");
    expect(providers.callMimo).toHaveBeenCalledTimes(1);
  });

  it("ships the frozen rubric verbatim and the complete production output contract", async () => {
    const { gate, providers } = service({ callMimo: jest.fn(async () => ({ value: { label: "drop", scope: "-", confidence: 1, records: [] }, cost: 0, requestHash: "m", rawReply: "{}" })) });
    await gate.propose({ content: "ephemeral", source: "a0", idempotencyKey: "prompt" });
    const prompt = providers.callMimo.mock.calls[0][0];
    expect(crypto.createHash("sha256").update(MEMORY_GATE_RUBRIC).digest("hex")).toBe("e82cfd51d4bb1625b16913f5d505f671a21284bba214399d3fa1e22d0698042a");
    expect(prompt).toContain(MEMORY_GATE_RUBRIC);
    for (const label of ["authority", "decision", "lesson", "preference", "project_fact", "receipt", "drop", "noise"]) expect(prompt).toContain(label);
    expect(prompt).toMatch(/scope.*global.*project/s);
    expect(prompt).toMatch(/receipt.*drop.*noise.*scope.*"-"/s);
    expect(prompt).toMatch(/receipt.*drop.*noise.*records.*empty/s);
    expect(prompt).toMatch(/keeper.*1 to 4 records/i);
  });

  it("keeps a maximum-size proposal prompt inside the MiMo input reservation", async () => {
    const { gate, providers } = service({ callMimo: jest.fn(async () => ({ value: { label: "drop", scope: "-", confidence: 1, records: [] }, cost: 0, requestHash: "m", rawReply: "{}" })) });
    await gate.propose({ content: "x".repeat(32_000), source: "a0", idempotencyKey: "max-prompt" });
    expect(Buffer.byteLength(providers.callMimo.mock.calls[0][0], "utf8")).toBeLessThanOrEqual(MIMO_MAX_INPUT_BYTES);
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
    const providers = { callMimo: async () => ({ value: keeper, cost: 0, requestHash: "m" }) };
    const gate = new MemoryGateService({ db: getSqlite(), providers: providers as any, prefilter: new Set(), mode: "shadow", embed: async () => new Array(1024).fill(0.1) });
    expect((await gate.propose({ content: "decision", source: "a0", idempotencyKey: "shadow" })).status).toBe("shadow");
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_records").get() as any).n).toBe(0);
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
    };
    const first = new MemoryGateService({ db: getSqlite(), providers, mode: "shadow" }).propose({ content: "decision", source: "a0", idempotencyKey: "overlap" });
    const second = new MemoryGateService({ db: getSqlite(), providers, mode: "shadow" }).propose({ content: "decision", source: "a0", idempotencyKey: "overlap" });
    release();
    expect(await second).toEqual(await first);
    expect(providers.callMimo).toHaveBeenCalledTimes(1);
    expect((getSqlite().prepare("SELECT count(*) AS n FROM memory_proposals").get() as any).n).toBe(1);
  });

  it("validates gate output", async () => {
    const { gate, providers } = service();
    await expect(gate.propose({ content: "decision", source: "a0", idempotencyKey: "strict" })).resolves.toMatchObject({ status: "accepted" });
    providers.callMimo.mockResolvedValueOnce({ value: { ...keeper, confidence: 2 }, cost: 0, requestHash: "bad" });
    await expect(gate.propose({ content: "bad", source: "a0", idempotencyKey: "invalid-schema" })).resolves.toMatchObject({ status: "quarantined" });
  });

  it("uses exactly one MiMo call for each triage and supersession decision", async () => {
    const repository = new MemoryRecordRepository(getSqlite());
    repository.upsertSource({ uid: "old-source", source: "fixture", text: "old source" });
    repository.insertRecord({ rid: "old", uid: "old-source", source: "fixture", kind: "decision", scope: "global", subject_key: "git.rule", text: "Old rule", status: "current" });
    repository.upsertEmbedding("old", new Array(1024).fill(0.1));
    const providers = {
      callMimo: jest.fn()
        .mockResolvedValueOnce({ value: keeper, cost: 0, requestHash: "triage" })
        .mockResolvedValueOnce({ value: { decision: "newer" }, cost: 0, requestHash: "pair" }),
    };
    const gate = new MemoryGateService({ db: getSqlite(), providers, mode: "active", embed: async () => new Array(1024).fill(0.2) });
    expect((await gate.propose({ content: "new", source: "a0", idempotencyKey: "vote" })).status).toBe("accepted");
    expect(providers.callMimo).toHaveBeenCalledTimes(2);
    expect((getSqlite().prepare("SELECT status FROM memory_records WHERE rid LIKE 'proposal:%#0'").get() as any).status).toBe("current");
    expect((getSqlite().prepare("SELECT status FROM memory_records WHERE rid='old'").get() as any).status).toBe("superseded");
  });

  it("does not partially write an active multi-record proposal", async () => {
    const multi = { ...keeper, records: [keeper.records[0], { subject_key: "other", text: "Second record" }] };
    const providers = { callMimo: async () => ({ value: multi, cost: 0, requestHash: "m" }) };
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
    const repository = new MemoryRecordRepository(getSqlite());
    repository.upsertSource({ uid: "prior-source", source: "fixture", text: "prior" });
    repository.insertRecord({ rid: "prior", uid: "prior-source", source: "fixture", kind: "decision", scope: "global", subject_key: "shared", text: "Prior rule", status: "current" });
    repository.upsertEmbedding("prior", new Array(1024).fill(0.05));
    const multi = { ...keeper, records: [
      { subject_key: "shared", text: "First rule" },
      { subject_key: "shared", text: "New rule" },
    ] };
    const providers = {
      callMimo: jest.fn()
        .mockResolvedValueOnce({ value: multi, cost: 0, requestHash: "triage" })
        .mockResolvedValueOnce({ value: { decision: "newer" }, cost: 0, requestHash: "pair-1" })
        .mockResolvedValueOnce({ value: { decision: "newer" }, cost: 0, requestHash: "pair-2" }),
    };
    const gate = new MemoryGateService({ db: getSqlite(), providers, mode: "active", embed: async text => new Array(1024).fill(text.startsWith("First") ? 0.1 : 0.2) });
    const result = await gate.propose({ content: "two versions", source: "a0", idempotencyKey: "staged" });
    expect(result.status).toBe("accepted");
    const rows = getSqlite().prepare("SELECT rid,status,superseded_by FROM memory_records ORDER BY rid").all() as any[];
    expect(rows).toHaveLength(3);
    const prior = rows.find(row => row.rid === "prior");
    const first = rows.find(row => row.rid.endsWith("#0"));
    const second = rows.find(row => row.rid.endsWith("#1"));
    expect(prior).toMatchObject({ status: "superseded", superseded_by: first.rid });
    expect(first).toMatchObject({ status: "superseded", superseded_by: second.rid });
    expect(second.status).toBe("current");
  });

  it("persists a capped 0600 raw reply and hash on triage validation failure", async () => {
    const rawReply = JSON.stringify({ label: "decision", scope: "global", confidence: 2, records: [] });
    const { gate } = service({ callMimo: jest.fn(async () => ({ value: JSON.parse(rawReply), cost: 0, requestHash: "bad", rawReply })) });
    const result: any = await gate.propose({ content: "bad", source: "a0", idempotencyKey: "raw-validation" });
    expect(result).toMatchObject({ status: "quarantined", raw_reply_sha256: crypto.createHash("sha256").update(rawReply).digest("hex"), raw_reply_bytes: Buffer.byteLength(rawReply), raw_reply_truncated: false });
    expect(fs.readFileSync(result.raw_reply_file, "utf8")).toBe(rawReply);
    expect(fs.statSync(result.raw_reply_file).mode & 0o777).toBe(0o600);
    expect(JSON.parse((getSqlite().prepare("SELECT result_json FROM memory_proposals WHERE idempotency_key=?").get("raw-validation") as any).result_json)).toEqual(result);
  });

  it("persists raw replies from exhausted parse failures and invalid supersession", async () => {
    const parseRaw = "not-json";
    const parseError = new MemoryProviderError("Invalid provider JSON", parseRaw);
    const first = service({ callMimo: jest.fn(async () => { throw parseError; }) });
    const parseResult: any = await first.gate.propose({ content: "bad", source: "a0", idempotencyKey: "raw-parse" });
    expect(fs.readFileSync(parseResult.raw_reply_file, "utf8")).toBe(parseRaw);

    const repository = new MemoryRecordRepository(getSqlite());
    repository.upsertSource({ uid: "old-source", source: "fixture", text: "old source" });
    repository.insertRecord({ rid: "old", uid: "old-source", source: "fixture", kind: "decision", scope: "global", subject_key: "git.rule", text: "Old rule", status: "current" });
    repository.upsertEmbedding("old", new Array(1024).fill(0.1));
    const pairRaw = '{"decision":"invalid"}';
    const second = service({ callMimo: jest.fn()
      .mockResolvedValueOnce({ value: keeper, cost: 0, requestHash: "triage", rawReply: "{}" })
      .mockResolvedValueOnce({ value: { decision: "invalid" }, cost: 0, requestHash: "pair", rawReply: pairRaw }) });
    const pairResult: any = await second.gate.propose({ content: "new", source: "a0", idempotencyKey: "raw-pair" });
    expect(fs.readFileSync(pairResult.raw_reply_file, "utf8")).toBe(pairRaw);
  });

  it("caps persisted raw replies while hashing the complete reply", async () => {
    const rawReply = "x".repeat(100_000);
    const { gate } = service({ callMimo: jest.fn(async () => ({ value: { label: "invalid" }, cost: 0, requestHash: "bad", rawReply })) });
    const result: any = await gate.propose({ content: "bad", source: "a0", idempotencyKey: "raw-capped" });
    expect(result).toMatchObject({
      raw_reply_sha256: crypto.createHash("sha256").update(rawReply).digest("hex"),
      raw_reply_bytes: 100_000,
      raw_reply_truncated: true,
    });
    expect(fs.statSync(result.raw_reply_file).size).toBe(64 * 1024);
  });

  it("quarantines instead of leaving a pending claim when raw evidence cannot be written", async () => {
    const blockedPath = path.join(root, "not-a-directory");
    fs.writeFileSync(blockedPath, "occupied");
    process.env.ARCRIFT_MEMORY_GATE_FAILURE_DIR = blockedPath;
    const rawReply = "not-json";
    const { gate } = service({ callMimo: jest.fn(async () => { throw new MemoryProviderError("Invalid provider JSON", rawReply); }) });
    const result: any = await gate.propose({ content: "bad", source: "a0", idempotencyKey: "raw-write-failure" });
    expect(result).toMatchObject({
      status: "quarantined",
      raw_reply_sha256: crypto.createHash("sha256").update(rawReply).digest("hex"),
      raw_reply_bytes: Buffer.byteLength(rawReply),
    });
    expect(result.raw_reply_persist_error).toMatch(/EEXIST/);
    expect((getSqlite().prepare("SELECT status FROM memory_proposals WHERE idempotency_key=?").get("raw-write-failure") as any).status).toBe("quarantined");
  });
});
