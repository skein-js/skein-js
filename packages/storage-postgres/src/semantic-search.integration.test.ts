import { startPostgres, type StartedResource } from "@skein-js/test-support";
import { Pool } from "pg";
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

describe("PostgresSkeinStore semantic search with store.index.hnsw", () => {
  // Catalog inspection goes through its own pool: the store deliberately does not expose one, and
  // adding a public accessor for a test's benefit would widen the driver's surface.
  let inspect: Pool;
  beforeAll(() => {
    inspect = new Pool({ connectionString: pg.url });
  });
  afterAll(async () => {
    await inspect?.end();
  });

  it("does not index the embedding column unless hnsw is opted into", async () => {
    // Off by default on purpose: HNSW is approximate, so enabling it changes which rows a search
    // returns. That is not something to inherit from an upgrade.
    const { rows } = await inspect.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'store_items'`,
    );
    expect(rows.map((row) => row.indexname)).not.toContain("store_items_embedding_hnsw_idx");

    const { rows: columns } = await inspect.query<{ format: string }>(
      `SELECT format_type(atttypid, atttypmod) AS format FROM pg_attribute
        WHERE attrelid = 'store_items'::regclass AND attname = 'embedding'`,
    );
    // Dimensionless, which is what lets the base schema work without knowing `dims`.
    expect(columns[0]?.format).toBe("vector");
  });

  it("pins the column dimension and builds the index when hnsw is on", async () => {
    const hnswStore = await PostgresSkeinStore.connect(pg.url, {
      index: { dims: 3, fields: ["text"], embed: fakeEmbed, hnsw: true },
    });
    try {
      await hnswStore.migrate();

      const { rows } = await inspect.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'store_items'`,
      );
      expect(rows.map((row) => row.indexname)).toContain("store_items_embedding_hnsw_idx");

      const { rows: columns } = await inspect.query<{ format: string }>(
        `SELECT format_type(atttypid, atttypmod) AS format FROM pg_attribute
          WHERE attrelid = 'store_items'::regclass AND attname = 'embedding'`,
      );
      // pgvector cannot index a dimensionless vector, so enabling HNSW pins the column.
      expect(columns[0]?.format).toBe("vector(3)");

      // Still returns the right answer — the index is an optimisation, not a behaviour change here.
      await hnswStore.truncateAll();
      await hnswStore.store.put(["docs"], "a", { text: "a fluffy cat" });
      await hnswStore.store.put(["docs"], "b", { text: "a fast car" });
      const hits = await hnswStore.store.search({ query: "kitten", prefix: ["docs"], limit: 1 });
      expect(hits[0]?.key).toBe("a");
    } finally {
      await hnswStore.close();
    }
  });

  it("reports a dimension mismatch actionably rather than as a raw Postgres error", async () => {
    // The realistic cause is an embedder or model change against a store that already has rows.
    //
    // Seeds its own row rather than relying on one an earlier test left behind: `ALTER COLUMN … TYPE
    // vector(99)` *succeeds* on an empty or all-NULL table, so without this the test would pass only
    // because of file ordering and would go green the moment it ran alone.
    const seeded = await PostgresSkeinStore.connect(pg.url, {
      index: { dims: 3, fields: ["text"], embed: fakeEmbed },
    });
    try {
      await seeded.truncateAll();
      await seeded.store.put(["docs"], "seed", { text: "a fluffy cat" });
    } finally {
      await seeded.close();
    }

    const mismatched = await PostgresSkeinStore.connect(pg.url, {
      index: { dims: 99, fields: ["text"], embed: fakeEmbed, hnsw: true },
    });
    try {
      // Matched on the ALTER wrapper specifically, not just "store.index.hnsw" — that substring is in
      // the `dims` guard message too, so a regression that rejected 99 during validation instead of
      // reaching Postgres would otherwise still pass.
      await expect(mismatched.migrate()).rejects.toThrow(
        /Could not pin store_items\.embedding to vector\(99\)/,
      );
    } finally {
      await mismatched.close();
    }
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 3.5],
    ["above pgvector's limit", 16_001],
    ["large enough to stringify in exponential form", 1e21],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a %s dimension before it reaches the SQL", async (_label, dims) => {
    // `dims` is interpolated into `ALTER TABLE … TYPE vector(<dims>)` because a type modifier cannot
    // be a bind parameter, so the guard is load-bearing. Nothing covered it before, which is exactly
    // how a missing upper bound survived a green run: `Number.isInteger(1e21)` is true, and
    // `String(1e21)` is "1e+21", which Postgres rejects with a misleading error.
    const store = await PostgresSkeinStore.connect(pg.url, {
      index: { dims, fields: ["text"], embed: fakeEmbed, hnsw: true },
    });
    try {
      await expect(store.migrate()).rejects.toThrow(/store\.index\.dims to be an integer/);
    } finally {
      await store.close();
    }
  });

  it("survives two instances setting up concurrently", async () => {
    // A rolling deploy. The protection is a *session*-scoped advisory lock spanning the concurrent
    // index build; a transaction-scoped one is released by the COMMIT that precedes the build, leaving
    // two unprotected `CREATE INDEX CONCURRENTLY` on the same index to deadlock — one instance dying
    // on a raw Postgres error while the survivor leaves an invalid index that `IF NOT EXISTS` then
    // skips forever, so HNSW is silently never used.
    //
    // Be clear about what this test is: a smoke test, not a reproduction. Verified by releasing the
    // lock early — it still passes, because a handful of rows builds far too fast for the two sessions
    // to overlap. The deadlock needs a table large enough for the build to take seconds (reproduced at
    // 400k rows). This guards the happy path and the "exactly one valid index" outcome; the ordering
    // guarantee itself rests on the lock, not on this.
    await inspect.query(`DROP INDEX IF EXISTS store_items_embedding_hnsw_idx`);
    const options = { dims: 3, fields: ["text"], embed: fakeEmbed, hnsw: true };
    const [first, second] = await Promise.all([
      PostgresSkeinStore.connect(pg.url, { index: options }),
      PostgresSkeinStore.connect(pg.url, { index: options }),
    ]);
    try {
      // Neither may reject, and the result must be one valid index.
      await Promise.all([first.migrate(), second.migrate()]);

      const { rows } = await inspect.query<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = 'store_items_embedding_hnsw_idx'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.valid).toBe(true);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("clears a leftover invalid index instead of rebuilding it inline", async () => {
    // An interrupted concurrent build leaves an invalid index. Pinning a column that has one attached
    // drops and rebuilds it *inline*, holding ACCESS EXCLUSIVE on store_items for the whole build —
    // measured at ~48s on 400k rows where the same ALTER against a valid index is ~3ms. So setup has
    // to clear it first and let the concurrent build below redo the work.
    await inspect.query(`DROP INDEX IF EXISTS store_items_embedding_hnsw_idx`);
    // Fake an interrupted build: a real one is hard to interrupt deterministically, and what matters
    // is only that the index exists and is marked invalid.
    await inspect.query(
      `CREATE INDEX store_items_embedding_hnsw_idx
         ON store_items USING hnsw (embedding vector_cosine_ops)`,
    );
    await inspect.query(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = 'store_items_embedding_hnsw_idx'::regclass`,
    );

    const store = await PostgresSkeinStore.connect(pg.url, {
      index: { dims: 3, fields: ["text"], embed: fakeEmbed, hnsw: true },
    });
    try {
      await store.migrate();
    } finally {
      await store.close();
    }

    // Rebuilt, and valid — which is what makes the index actually usable again.
    const { rows } = await inspect.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'store_items_embedding_hnsw_idx'`,
    );
    expect(rows[0]?.valid).toBe(true);
  });
});
