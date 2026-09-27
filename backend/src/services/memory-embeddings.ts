import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import { MemoryBudget } from "./memory-budget";

export const MEMORY_EMBEDDING_MODEL = "voyageai/voyage-4-lite";
export const MEMORY_EMBEDDING_DIMENSIONS = 1024;
export const MAX_EMBEDDING_INPUT_BYTES = 16_000;
export const EMBEDDING_ATTEMPT_RESERVATION_USD = 0.005;
export const EMBEDDING_WORST_CASE_USD = MAX_EMBEDDING_INPUT_BYTES * 0.03 / 1_000_000;

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

export class MemoryEmbeddingService {
  constructor(
    private readonly apiKey = process.env.ARCRIFT_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
    private readonly client: AxiosInstance = axios.create({ baseURL: "https://openrouter.ai/api/v1", timeout: 30_000 }),
    private readonly retries = 2,
    private readonly budget: MemoryBudget = new MemoryBudget(),
  ) {}

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) throw new Error("An OpenRouter key is required for curated memory embeddings");
    const boundedText = truncateUtf8(text, MAX_EMBEDDING_INPUT_BYTES);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const reservationId = crypto.randomUUID();
      if (!this.budget.reserve(reservationId, "openrouter", MEMORY_EMBEDDING_MODEL, EMBEDDING_ATTEMPT_RESERVATION_USD)) throw new Error("budget_hold");
      try {
        const response = await this.client.post("/embeddings", {
          model: MEMORY_EMBEDDING_MODEL,
          input: [boundedText],
          dimensions: MEMORY_EMBEDDING_DIMENSIONS,
          provider: { allow_fallbacks: false, max_price: { prompt: 0.03, completion: 0 } },
        }, {
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        });
        const reportedCost = response.data?.usage?.cost ?? response.data?.usage?.cost_details?.upstream_inference_cost;
        const cost = Number(reportedCost);
        if (reportedCost == null) throw new Error("Missing embedding provider cost");
        if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid embedding provider cost");
        const requestHash = crypto.createHash("sha256").update(`${reservationId}\0${boundedText}\0${attempt}\0${JSON.stringify(response.data?.usage ?? {})}`).digest("hex");
        this.budget.settle(reservationId, cost, requestHash);
        const embedding = response.data?.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length !== MEMORY_EMBEDDING_DIMENSIONS || embedding.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value))) {
          throw new Error(`Embedding response must contain ${MEMORY_EMBEDDING_DIMENSIONS} finite values`);
        }
        return embedding;
      } catch (error) {
        this.budget.forfeit(reservationId);
        lastError = error;
        if (attempt < this.retries) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
