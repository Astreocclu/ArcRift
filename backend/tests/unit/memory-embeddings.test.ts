import fs from "fs";
import os from "os";
import path from "path";
import { initSqlite, getSqlite } from "../../src/services/sqlite";
import { MemoryBudget } from "../../src/services/memory-budget";
import { EMBEDDING_ATTEMPT_RESERVATION_USD, EMBEDDING_WORST_CASE_USD, MemoryEmbeddingService } from "../../src/services/memory-embeddings";

describe("budgeted memory embeddings", () => {
  it("caps input and records provider-reported cost", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-embedding-budget-"));
    process.env.SQLITE_DB_PATH = path.join(root, "db.sqlite");
    initSqlite();
    const client: any = { post: jest.fn(async (_path, body) => {
      expect(Buffer.byteLength(body.input[0], "utf8")).toBeLessThanOrEqual(16_000);
      expect(body.provider).toEqual({ allow_fallbacks: false, max_price: { prompt: 0.03, completion: 0 } });
      return { data: { data: [{ embedding: new Array(1024).fill(0.1) }], usage: { cost: 0.002 } } };
    }) };
    const service = new MemoryEmbeddingService("test", client, 0, new MemoryBudget(getSqlite()));
    expect(EMBEDDING_WORST_CASE_USD).toBeLessThan(EMBEDDING_ATTEMPT_RESERVATION_USD);
    await expect(service.embed("x".repeat(20_000))).resolves.toHaveLength(1024);
    expect((getSqlite().prepare("SELECT sum(cost_usd) AS total FROM memory_usage").get() as any).total).toBeCloseTo(0.002);
    await expect(service.embed("x".repeat(20_000))).resolves.toHaveLength(1024);
    expect((getSqlite().prepare("SELECT sum(cost_usd) AS total FROM memory_usage").get() as any).total).toBeCloseTo(0.004);
    getSqlite().close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
