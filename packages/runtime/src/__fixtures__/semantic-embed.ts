// A deterministic, network-free embedder for the semantic-search wiring test: "cat"/"kitten"
// cluster together and away from "car", so cosine ranking is predictable.
const POINTS: Record<string, [number, number, number]> = {
  cat: [1, 0, 0],
  kitten: [0.9, 0.1, 0],
  car: [0, 1, 0],
};

export function embed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      for (const [word, point] of Object.entries(POINTS)) if (text.includes(word)) return point;
      return [0, 0, 1];
    }),
  );
}
