export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export function assertEmbedding(vector: readonly number[], dimensions: number): void {
  if (vector.length !== dimensions) throw new Error(`embedding_dimension_mismatch:${vector.length}:${dimensions}`);
  if (vector.some((value) => !Number.isFinite(value))) throw new Error("embedding_non_finite");
}

export async function embedBatches(
  provider: EmbeddingProvider,
  texts: readonly string[],
  options: { batchSize?: number } = {}
): Promise<number[][]> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 32, 256));
  const output: number[][] = [];
  for (let index = 0; index < texts.length; index += batchSize) {
    const batch = texts.slice(index, index + batchSize);
    const vectors = await provider.embed(batch);
    if (vectors.length !== batch.length) throw new Error("embedding_batch_size_mismatch");
    for (const vector of vectors) assertEmbedding(vector, provider.dimensions);
    output.push(...vectors);
  }
  return output;
}
