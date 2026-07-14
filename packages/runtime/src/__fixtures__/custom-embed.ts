// Fixtures for resolve-embed tests: the two shapes a custom `store.index.embed` path may export.

/** A raw embed function — the exact `(texts) => number[][]` shape LangGraph documents. */
export function embed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map((_, i) => [i, i + 1, i + 2]));
}

/** A LangChain `Embeddings`-like instance (only `embedDocuments` is needed). */
export const embeddingsInstance = {
  embedDocuments: (texts: string[]): Promise<number[][]> =>
    Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
};

/** A bad export — neither a function nor an Embeddings instance. */
export const notAnEmbedder = { nope: true };
