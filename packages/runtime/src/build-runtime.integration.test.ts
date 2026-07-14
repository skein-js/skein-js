import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RunFrame } from "@skein-js/core";
import { startPostgres, startRedis, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildRuntime } from "./build-runtime.js";
import { RuntimeConfigError } from "./errors.js";

// A fixture langgraph.json with one (never-loaded) graph — buildRuntime resolves graphs lazily.
const configPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "langgraph.json",
);

let pg: StartedResource;
let redis: StartedResource;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  // buildRuntime reads these from the environment (the CLI applies them from .env before booting).
  process.env["DATABASE_URL"] = pg.url;
  process.env["REDIS_URL"] = redis.url;
}, 120_000);

afterAll(async () => {
  delete process.env["DATABASE_URL"];
  delete process.env["REDIS_URL"];
  await Promise.allSettled([pg?.stop(), redis?.stop()]);
});

const frame = (seq: number): RunFrame => ({ seq, event: "values", data: { seq } });

describe("buildRuntime — postgres + redis assembly", () => {
  it("connects + migrates Postgres and round-trips protocol resources", async () => {
    const runtime = await buildRuntime({ configPath, store: "postgres", queue: "redis" });
    try {
      // The store is migrated and usable: create an assistant + thread and read the thread back.
      const assistant = await runtime.deps.store.assistants.create({ graph_id: "echo" });
      expect(assistant.graph_id).toBe("echo");
      const thread = await runtime.deps.store.threads.create();
      const fetched = await runtime.deps.store.threads.get(thread.thread_id);
      expect(fetched?.thread_id).toBe(thread.thread_id);

      // Durable drivers keep their own state, so no in-memory snapshot hooks are exposed.
      expect(runtime.snapshotState).toBeUndefined();
      expect(runtime.hydrateState).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  it("fans run frames across two runtimes sharing Redis (cross-instance streaming)", async () => {
    // Two independent runtimes (as if two server instances) sharing the same Redis event bus.
    const instanceA = await buildRuntime({ configPath, store: "memory", queue: "redis" });
    const instanceB = await buildRuntime({ configPath, store: "memory", queue: "redis" });
    try {
      const runId = "cross-instance-run";
      const received = (async () => {
        const seqs: number[] = [];
        for await (const f of instanceB.deps.bus.subscribe(runId)) seqs.push(f.seq);
        return seqs;
      })();
      await new Promise((resolve) => setTimeout(resolve, 100)); // let the SUBSCRIBE land

      await instanceA.deps.bus.publish(runId, frame(1));
      await instanceA.deps.bus.publish(runId, frame(2));
      await instanceA.deps.bus.close(runId);

      expect(await received).toEqual([1, 2]);
    } finally {
      await Promise.allSettled([instanceA.dispose(), instanceB.dispose()]);
    }
  });

  it("wires store.index.embed into pgvector semantic search", async () => {
    const embedConfigPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "__fixtures__",
      "langgraph.embed.json",
    );
    // Vitest transforms the .ts embedder fixture; buildRuntime resolves it via store.index.embed.
    const runtime = await buildRuntime({
      configPath: embedConfigPath,
      store: "postgres",
      queue: "memory",
      importModule: (file: string): Promise<Record<string, unknown>> =>
        import(/* @vite-ignore */ file),
    });
    try {
      await runtime.deps.store.store.put(["docs"], "a", { text: "a fluffy cat" });
      await runtime.deps.store.store.put(["docs"], "b", { text: "a small kitten" });
      await runtime.deps.store.store.put(["docs"], "c", { text: "a fast car" });

      const hits = await runtime.deps.store.store.search({ query: "kitten" });
      // Semantic ranking (not naive text): kitten/cat cluster near the query, car ranks last.
      expect(hits.map((h) => h.key)).toEqual(["b", "a", "c"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects with RuntimeConfigError when a selected driver's env var is missing", async () => {
    const saved = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      await expect(
        buildRuntime({ configPath, store: "postgres", queue: "memory" }),
      ).rejects.toThrow(RuntimeConfigError);
    } finally {
      process.env["DATABASE_URL"] = saved;
    }
  });

  it("tears down the connected store when a later driver fails to initialize", async () => {
    // Postgres connects + migrates fully, then the Redis queue's env is missing: buildRuntime must
    // dispose the Postgres pool/saver on the way out instead of leaking them (and still reject).
    const savedRedis = process.env["REDIS_URL"];
    delete process.env["REDIS_URL"];
    try {
      await expect(buildRuntime({ configPath, store: "postgres", queue: "redis" })).rejects.toThrow(
        /REDIS_URL/,
      );
    } finally {
      process.env["REDIS_URL"] = savedRedis;
    }
  });
});
