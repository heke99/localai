import { retrieveHybrid, type KnowledgeChunk } from "./index";
import type { EmbeddingProvider } from "./embeddings";
import { semanticSearch, type KnowledgeStore } from "./store";

export interface RetrievedKnowledge {
  chunks: Array<KnowledgeChunk & { score: number }>;
  context: string;
  citations: Array<KnowledgeChunk["citation"]>;
}

export class KnowledgeRetriever {
  constructor(
    private readonly embeddings: EmbeddingProvider,
    private readonly store: KnowledgeStore,
    private readonly lexicalCandidates: (tenantId: string) => Promise<KnowledgeChunk[]>
  ) {}

  async retrieve(input: { tenantId: string; query: string; limit?: number }): Promise<RetrievedKnowledge> {
    const limit = Math.max(1, Math.min(input.limit ?? 8, 20));
    const semantic = await semanticSearch(input.query, input.tenantId, this.embeddings, this.store, Math.max(limit * 3, 20));
    const vectorScores = new Map(semantic.map((chunk) => [chunk.id, chunk.vectorScore]));
    const lexical = await this.lexicalCandidates(input.tenantId);
    const merged = new Map<string, KnowledgeChunk>();
    for (const chunk of [...lexical, ...semantic]) merged.set(chunk.id, chunk);
    const chunks = retrieveHybrid(input.query, [...merged.values()], { tenantId: input.tenantId, limit, vectorScores });
    const citations = chunks.map((chunk) => chunk.citation);
    const context = chunks.map((chunk, index) => {
      const source = chunk.citation.uri;
      return `<retrieved_context index="${index + 1}" source="${source}">\n${chunk.content}\n</retrieved_context>`;
    }).join("\n\n");
    return { chunks, context, citations };
  }
}
