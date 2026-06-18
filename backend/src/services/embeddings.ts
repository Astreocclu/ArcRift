// Embeddings via local Ollama nomic-embed-text (137M param, pure embedding, NOT an LLM).
// No generation, no chat, no tokens consumed. Pure text → vector.
// keep_alive=0 unloads the model immediately after each call so the ~290MB runner
// footprint is held only for the duration of the embedding (RAM-starved host).
import axios from "axios";
import { logger } from "../utils/logger";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = "nomic-embed-text:latest";
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? 0;
const MAX_RETRIES = 3;

export async function generateEmbedding(text: string, task: "query" | "document" = "query"): Promise<number[]> {
  const prefix = task === "query" ? "search_query: " : "search_document: ";
  const prompt = `${prefix}${text}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
      const resp = await axios.post(`${OLLAMA_URL}/api/embeddings`, { model: MODEL, prompt, keep_alive: KEEP_ALIVE }, { timeout: 30000 });
      return resp.data.embedding as number[];
    } catch (err: any) {
      if (attempt < MAX_RETRIES) continue;
      throw new Error(`Embedding failed: ${err.message}`);
    }
  }
  throw new Error("Embedding failed after retries.");
}

export async function generateEmbeddings(texts: string[], task: "query" | "document" = "document"): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += 3) {
    const batch = texts.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map(t => generateEmbedding(t, task)));
    results.push(...batchResults);
    if (i + 3 < texts.length) await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

export async function checkOllamaHealth(): Promise<boolean> {
  try {
    await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
