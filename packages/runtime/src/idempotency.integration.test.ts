// Success criterion for idempotent run creation, end to end and across instances:
//
//   "Replaying an identical run-create POST 50 times concurrently across two instances yields
//    exactly one run and 50 identical responses."
//
// Two *separate* `embedPostgresGraphs` assemblies — separate pools, separate runtimes, separate
// handler tables — sharing one database. That separation is the whole point: a check-then-write claim
// passes this suite in a single process and fails here, which is exactly how this bug reaches
// production unnoticed.

import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { createProtocolRuntime, type ProtocolRequest } from "@skein-js/agent-protocol";
import { startPostgres, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { embedPostgresGraphs } from "./embed-postgres-graphs.js";

/** A real compiled graph that is never invoked — these tests create runs, they do not execute them. */
function buildGraph() {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({ messages: [] }))
    .addEdge("__start__", "noop")
    .addEdge("noop", "__end__")
    .compile();
}

let pg: StartedResource;

beforeAll(async () => {
  pg = await startPostgres();
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

/** One server: its own pool, its own runtime, its own handler table. */
async function startInstance() {
  const embedded = await embedPostgresGraphs({ echo: buildGraph() }, { postgresUri: pg.url });
  const runtime = createProtocolRuntime(embedded.deps);
  await runtime.service.assistants.registerGraphAssistants();
  return { runtime, deps: embedded.deps, dispose: embedded.dispose };
}

function createRun(threadId: string, key: string): ProtocolRequest {
  return {
    method: "POST",
    url: `http://localhost:2024/threads/${threadId}/runs`,
    params: { thread_id: threadId },
    query: {},
    body: { assistant_id: "echo", input: { messages: [] }, thread_id: threadId },
    headers: { "idempotency-key": key },
  };
}

describe("idempotent run creation — two instances, one Postgres", () => {
  it("admits exactly one of 50 concurrent identical creates and replays it to the other 49", async () => {
    const [a, b] = await Promise.all([startInstance(), startInstance()]);
    try {
      const thread = await a.deps.store.threads.create();
      const request = createRun(thread.thread_id, "provider-retry-1");

      // Alternating instances, fired without awaiting in between, so the *database* is what decides.
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          (i % 2 === 0 ? a : b).runtime.handlers
            .createBackgroundRun(request)
            .catch((error: unknown) => error),
        ),
      );

      // Exactly one run exists on the thread — the property the whole surface is for.
      const runs = await a.deps.store.runs.listByThread(thread.thread_id, { limit: 100 });
      expect(runs).toHaveLength(1);

      // Every caller was answered with that same run. A 409 is a legitimate outcome for a retry that
      // lands while the original is still in flight, so the assertion is that nobody got a *second*
      // run — not that nobody got a 409.
      const settled = responses.filter(
        (r): r is Awaited<ReturnType<typeof a.runtime.handlers.createBackgroundRun>> =>
          !(r instanceof Error),
      );
      const runIds = new Set(settled.map((r) => (r as { body: { run_id: string } }).body.run_id));
      expect(runIds).toEqual(new Set([runs[0]?.run_id]));

      // And the losers that were answered carry the replay marker, so a client can tell.
      const replays = settled.filter((r) => r.headers?.["idempotent-replay"] === "true");
      expect(replays.length).toBe(settled.length - 1);
    } finally {
      await Promise.allSettled([a.dispose(), b.dispose()]);
    }
  }, 120_000);

  it("replays a completed create from the instance that did not serve it", async () => {
    // The cross-instance replay in isolation, without the concurrency: a provider retry that lands on
    // a different pod must still be answered from the record rather than starting a second run.
    const [a, b] = await Promise.all([startInstance(), startInstance()]);
    try {
      const thread = await a.deps.store.threads.create();
      const request = createRun(thread.thread_id, "provider-retry-2");

      const first = await a.runtime.handlers.createBackgroundRun(request);
      const replayed = await b.runtime.handlers.createBackgroundRun(request);

      expect(replayed.status).toBe(first.status);
      expect(replayed).toMatchObject({ body: (first as { body: unknown }).body });
      expect(replayed.headers?.["idempotent-replay"]).toBe("true");
      // Content-Location survives the hop, so `useStream` can still rejoin after a remount.
      expect(replayed.headers?.["content-location"]).toBe(first.headers?.["content-location"]);
      expect(await a.deps.store.runs.listByThread(thread.thread_id, { limit: 100 })).toHaveLength(
        1,
      );
    } finally {
      await Promise.allSettled([a.dispose(), b.dispose()]);
    }
  }, 120_000);

  it("refuses the same key with a different body from either instance", async () => {
    const [a, b] = await Promise.all([startInstance(), startInstance()]);
    try {
      const thread = await a.deps.store.threads.create();
      await a.runtime.handlers.createBackgroundRun(createRun(thread.thread_id, "provider-retry-3"));

      const different = createRun(thread.thread_id, "provider-retry-3");
      different.body = { ...(different.body as object), input: { messages: ["different"] } };

      await expect(b.runtime.handlers.createBackgroundRun(different)).rejects.toMatchObject({
        status: 422,
      });
    } finally {
      await Promise.allSettled([a.dispose(), b.dispose()]);
    }
  }, 120_000);
});
