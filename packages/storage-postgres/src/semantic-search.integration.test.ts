import { startPostgres, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresSkeinStore, type EmbedFunction } from "./postgres-skein-store.js";

// A deterministic, network-free embedder: each item's text maps to a fixed 3-D point, so cosine
// ranking is predictable. "cat"/"kitten" cluster together and away from "car", letting us assert
// that a semantic query returns the nearest items first — the pgvector path, distinct from the
// naive text fallback the conformance suite exercises.
const POINTS: Record<string, [number, number, number]> = {
  cat: [1, 0, 0],
  kitten: [0.9, 0.1, 0],
  car: [0, 1, 0],
};
const fakeEmbed: EmbedFunction = async (texts) =>
  texts.map((text) => {
    for (const [word, point] of Object.entries(POINTS)) if (text.includes(word)) return point;
    return [0, 0, 1];
  });

let pg: StartedResource;
let store: PostgresSkeinStore;

beforeAll(async () => {
  pg = await startPostgres();
  store = await PostgresSkeinStore.connect(pg.url, {
    index: { dims: 3, fields: ["text"], embed: fakeEmbed },
  });
  await store.migrate();
});
afterAll(async () => {
  await store?.close();
  await pg?.stop();
});

describe("PostgresSkeinStore semantic search (pgvector)", () => {
  it("ranks items by embedding proximity to the query", async () => {
    await store.truncateAll();
    await store.store.put(["docs"], "a", { text: "a fluffy cat" });
    await store.store.put(["docs"], "b", { text: "a small kitten" });
    await store.store.put(["docs"], "c", { text: "a fast car" });

    const hits = await store.store.search({ query: "kitten" });

    // "kitten" and "cat" are near the query; "car" is far — so the car ranks last.
    expect(hits.map((h) => h.key)).toEqual(["b", "a", "c"]);
    expect(hits[0]?.score).toBeGreaterThan(hits[2]?.score ?? 1);
  });

  it("respects the namespace prefix and limit under semantic ranking", async () => {
    await store.truncateAll();
    await store.store.put(["docs", "pets"], "a", { text: "a fluffy cat" });
    await store.store.put(["docs", "autos"], "c", { text: "a fast car" });

    const hits = await store.store.search({ query: "cat", prefix: ["docs", "pets"], limit: 5 });
    expect(hits.map((h) => h.key)).toEqual(["a"]);
  });
});
