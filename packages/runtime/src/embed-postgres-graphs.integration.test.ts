import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { MemoryRunEventBus, MemoryRunQueue } from "@skein-js/storage-memory";
import { startPostgres, startRedis, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { embedPostgresGraphs } from "./embed-postgres-graphs.js";
import { RuntimeConfigError } from "./errors.js";

/** A minimal, real compiled graph — a valid `EmbeddableGraph`. These tests round-trip protocol
 * resources through the store; they never invoke a run, so the graph body is never executed. */
function buildGraph() {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({ messages: [] }))
    .addEdge("__start__", "noop")
    .addEdge("noop", "__end__")
    .compile();
}

let pg: StartedResource;
let redis: StartedResource;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([pg?.stop(), redis?.stop()]);
});

describe("embedPostgresGraphs — durable in-code embedding", () => {
  it("connects + migrates Postgres and round-trips protocol resources (explicit URIs)", async () => {
    const { deps, dispose } = await embedPostgresGraphs(
      { echo: buildGraph() },
      { postgresUri: pg.url, redisUri: redis.url },
    );
    try {
      // The store is migrated and usable: create an assistant + thread and read the thread back.
      const assistant = await deps.store.assistants.create({ graph_id: "echo" });
      expect(assistant.graph_id).toBe("echo");
      const thread = await deps.store.threads.create();
      const fetched = await deps.store.threads.get(thread.thread_id);
      expect(fetched?.thread_id).toBe(thread.thread_id);
      // The graph map became a resolver keyed by the map keys.
      expect(deps.graphs.ids).toEqual(["echo"]);
    } finally {
      await dispose();
    }
  });

  it("reads POSTGRES_URI / REDIS_URI from the environment when no URIs are passed", async () => {
    const saved = { pg: process.env["POSTGRES_URI"], redis: process.env["REDIS_URI"] };
    process.env["POSTGRES_URI"] = pg.url;
    process.env["REDIS_URI"] = redis.url;
    try {
      const { deps, dispose } = await embedPostgresGraphs({ echo: buildGraph() });
      try {
        const thread = await deps.store.threads.create();
        expect(typeof thread.thread_id).toBe("string");
      } finally {
        await dispose();
      }
    } finally {
      restoreEnv("POSTGRES_URI", saved.pg);
      restoreEnv("REDIS_URI", saved.redis);
    }
  });

  it("falls back to an in-memory queue + bus when no Redis URL is configured (single instance)", async () => {
    const savedRedis = process.env["REDIS_URI"];
    delete process.env["REDIS_URI"];
    try {
      const { deps, dispose } = await embedPostgresGraphs(
        { echo: buildGraph() },
        { postgresUri: pg.url }, // no redisUri, REDIS_URI unset → in-memory queue/bus
      );
      try {
        expect(deps.queue).toBeInstanceOf(MemoryRunQueue);
        expect(deps.bus).toBeInstanceOf(MemoryRunEventBus);
        // The Postgres store is still durable and usable.
        const thread = await deps.store.threads.create();
        expect(await deps.store.threads.get(thread.thread_id)).not.toBeNull();
      } finally {
        await dispose(); // closes only the Postgres pools — there is no Redis to tear down
      }
    } finally {
      restoreEnv("REDIS_URI", savedRedis);
    }
  });

  it("wires an in-code index into pgvector semantic search", async () => {
    // A deterministic, network-free embedder: "cat"/"kitten" cluster, "car" is far — so cosine
    // ranking is predictable. This exercises the StoreIndexConfig seam directly (no langgraph.json).
    const POINTS: Record<string, [number, number, number]> = {
      cat: [1, 0, 0],
      kitten: [0.9, 0.1, 0],
      car: [0, 1, 0],
    };
    const embed = async (texts: string[]): Promise<number[][]> =>
      texts.map((text) => {
        for (const [word, point] of Object.entries(POINTS)) if (text.includes(word)) return point;
        return [0, 0, 1];
      });

    const { deps, dispose } = await embedPostgresGraphs(
      { echo: buildGraph() },
      { postgresUri: pg.url, redisUri: redis.url, index: { dims: 3, fields: ["text"], embed } },
    );
    try {
      await deps.store.store.put(["docs"], "a", { text: "a fluffy cat" });
      await deps.store.store.put(["docs"], "b", { text: "a small kitten" });
      await deps.store.store.put(["docs"], "c", { text: "a fast car" });

      const hits = await deps.store.store.search({ query: "kitten" });
      // Semantic ranking (not naive text): kitten/cat cluster near the query, car ranks last.
      expect(hits.map((h) => h.key)).toEqual(["b", "a", "c"]);
    } finally {
      await dispose();
    }
  });

  it("rejects with RuntimeConfigError when POSTGRES_URI is missing", async () => {
    const saved = process.env["POSTGRES_URI"];
    delete process.env["POSTGRES_URI"];
    try {
      await expect(embedPostgresGraphs({ echo: buildGraph() })).rejects.toThrow(RuntimeConfigError);
    } finally {
      restoreEnv("POSTGRES_URI", saved);
    }
  });

  it("dispose() tears down the Postgres pool (the shared rollback/shutdown path)", async () => {
    // Proves the disposers registered during assembly release the real Postgres pool — the same
    // teardown `runDisposers` runs on a partial-assembly failure. After dispose the pool is ended, so
    // any further store operation must reject rather than silently reusing a closed pool.
    const { deps, dispose } = await embedPostgresGraphs(
      { echo: buildGraph() },
      { postgresUri: pg.url, redisUri: redis.url },
    );
    await deps.store.threads.create(); // pool is live before dispose
    await dispose();
    await expect(deps.store.threads.create()).rejects.toThrow();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
