import axios, { AxiosInstance } from "axios";

export const MEMORY_EMBEDDING_MODEL = "voyageai/voyage-4-lite";
export const MEMORY_EMBEDDING_DIMENSIONS = 1024;

export class MemoryEmbeddingService {
  constructor(
    private readonly apiKey = process.env.ARCRIFT_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
    private readonly client: AxiosInstance = axios.create({ baseURL: "https://openrouter.ai/api/v1", timeout: 30_000 }),
    private readonly retries = 2,
  ) {}

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) throw new Error("An OpenRouter key is required for curated memory embeddings");
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const response = await this.client.post("/embeddings", {
          model: MEMORY_EMBEDDING_MODEL,
          input: [text],
        }, {
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        });
        const embedding = response.data?.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length !== MEMORY_EMBEDDING_DIMENSIONS || embedding.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value))) {
          throw new Error(`Embedding response must contain ${MEMORY_EMBEDDING_DIMENSIONS} finite values`);
        }
        return embedding;
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
