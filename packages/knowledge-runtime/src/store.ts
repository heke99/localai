import type { KnowledgeChunk } from "./index";
import { assertEmbedding, type EmbeddingProvider } from "./embeddings";

export interface StoredKnowledgeChunk extends KnowledgeChunk {
  embedding: number[];
}

export interface KnowledgeSearchResult extends KnowledgeChunk {
  vectorScore: number;
}

export interface KnowledgeStore {
  upsert(chunks: readonly StoredKnowledgeChunk[]): Promise<void>;
  search(input: { tenantId: string; embedding: readonly number[]; limit: number }): Promise<KnowledgeSearchResult[]>;
}

export async function indexKnowledgeChunks(
  chunks: readonly KnowledgeChunk[],
  provider: EmbeddingProvider,
  store: KnowledgeStore
): Promise<void> {
  if (!chunks.length) return;
  const { embedBatches } = await import("./embeddings");
  const embeddings = await embedBatches(provider, chunks.map((chunk) => chunk.content));
  await store.upsert(chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings[index]! })));
}

export async function semanticSearch(
  query: string,
  tenantId: string,
  provider: EmbeddingProvider,
  store: KnowledgeStore,
  limit: number
): Promise<KnowledgeSearchResult[]> {
  const [embedding] = await provider.embed([query]);
  if (!embedding) throw new Error("embedding_provider_empty_result");
  assertEmbedding(embedding, provider.dimensions);
  return store.search({ tenantId, embedding, limit });
}
