import type { KnowledgeSearchResult, KnowledgeStore, StoredKnowledgeChunk } from "./store";

export interface PgVectorClient {
  upsertKnowledge(chunks: readonly StoredKnowledgeChunk[]): Promise<void>;
  searchKnowledge(input: { tenantId: string; embedding: readonly number[]; limit: number }): Promise<KnowledgeSearchResult[]>;
}

export class PgVectorKnowledgeStore implements KnowledgeStore {
  constructor(private readonly client: PgVectorClient) {}
  upsert(chunks: readonly StoredKnowledgeChunk[]): Promise<void> {
    return this.client.upsertKnowledge(chunks);
  }
  search(input: { tenantId: string; embedding: readonly number[]; limit: number }): Promise<KnowledgeSearchResult[]> {
    return this.client.searchKnowledge(input);
  }
}
