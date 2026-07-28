// `POST /threads/{id}/history` reads its options from the **body**, which is where the LangGraph SDK
// puts them (`json: { limit, before, metadata, checkpoint }`, limit defaulting to 10). Reading `?limit`
// instead meant a real client's limit was silently dropped and the endpoint drained the thread's whole
// checkpoint history — so these assert on the request shape, not just on the response length.

import { describe, expect, it } from "vitest";

import { createFixtureDeps, createFixtureResolver } from "./__fixtures__/deps.js";
import { createContext } from "./context.js";
import { createProtocolHandlers, type ProtocolRequest } from "./create-handlers.js";
import type { GraphResolver, ResolvedGraph } from "./deps.js";
import { createProtocolServiceFromContext } from "./service.js";
import { DEFAULT_THREAD_HISTORY_LIMIT } from "./threads/thread-service.js";

interface CheckpointListOptions {
  limit?: number;
  before?: { configurable?: Record<string, unknown> };
  filter?: Record<string, unknown>;
}

/** A resolver recording the options each `getStateHistory` call receives, then delegating. */
function recordingResolver(calls: (CheckpointListOptions | undefined)[]): GraphResolver {
  const inner = createFixtureResolver();
  return {
    ...inner,
    load: async (graphId) => {
      const graph = await inner.load(graphId);
      return new Proxy(graph as object, {
        get(target, property, receiver) {
          if (property !== "getStateHistory") return Reflect.get(target, property, receiver);
          return (config: unknown, options?: CheckpointListOptions) => {
            calls.push(options);
            return (
              target as {
                getStateHistory: (c: unknown, o?: CheckpointListOptions) => AsyncIterable<unknown>;
              }
            ).getStateHistory(config, options);
          };
        },
      }) as ResolvedGraph;
    },
  };
}

function request(): ProtocolRequest {
  return { method: "post", url: "http://localhost/", params: {}, query: {}, body: {}, headers: {} };
}

async function historyHandler() {
  const calls: (CheckpointListOptions | undefined)[] = [];
  const service = createProtocolServiceFromContext(
    createContext(createFixtureDeps({ graphs: recordingResolver(calls) })),
  );
  await service.assistants.registerGraphAssistants();
  const handlers = createProtocolHandlers(service);
  const thread = await service.threads.create();
  await service.runs.createWait({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    input: { value: "hi" },
  });
  calls.length = 0; // the run itself reads state; only the history calls below matter
  const call = async (body: unknown, query: Record<string, string | string[]> = {}) =>
    handlers.getThreadHistory({
      ...request(),
      params: { thread_id: thread.thread_id },
      query,
      body,
    });
  return { call, calls };
}

describe("getThreadHistory", () => {
  it("reads the limit from the body, the way the SDK sends it", async () => {
    const { call, calls } = await historyHandler();

    await call({ limit: 5 });

    expect(calls).toEqual([{ limit: 5 }]);
  });

  it("defaults the limit when the body names none, rather than draining the history", async () => {
    const { call, calls } = await historyHandler();

    await call({});

    expect(calls).toEqual([{ limit: DEFAULT_THREAD_HISTORY_LIMIT }]);
  });

  it("still accepts ?limit for a hand-rolled caller, and bounds it", async () => {
    const { call, calls } = await historyHandler();

    await call({}, { limit: "7" });
    await call({}, { limit: "1000000" });

    expect(calls).toEqual([{ limit: 7 }, { limit: 1000 }]);
  });

  it("prefers the body's limit over a query param", async () => {
    const { call, calls } = await historyHandler();

    await call({ limit: 5 }, { limit: "7" });

    expect(calls).toEqual([{ limit: 5 }]);
  });

  it("passes `before` through, accepting a config or a bare checkpoint id", async () => {
    const { call, calls } = await historyHandler();

    await call({ before: { configurable: { checkpoint_id: "c-1" } } });
    await call({ before: "c-2" });

    expect(calls).toEqual([
      { limit: DEFAULT_THREAD_HISTORY_LIMIT, before: { configurable: { checkpoint_id: "c-1" } } },
      { limit: DEFAULT_THREAD_HISTORY_LIMIT, before: { configurable: { checkpoint_id: "c-2" } } },
    ]);
  });

  it("maps `metadata` to the checkpoint filter", async () => {
    const { call, calls } = await historyHandler();

    await call({ metadata: { source: "loop" } });

    expect(calls).toEqual([{ limit: DEFAULT_THREAD_HISTORY_LIMIT, filter: { source: "loop" } }]);
  });

  it("rejects a limit above the cap rather than accepting it", async () => {
    const { call } = await historyHandler();

    await expect(call({ limit: 5000 })).rejects.toMatchObject({ status: 400 });
    await expect(call({ limit: 0 })).rejects.toMatchObject({ status: 400 });
  });

  // A malformed `before` used to reach the checkpointer, which throws a plain Error — surfacing as a 500
  // on an unauthenticated endpoint. And a `before` with no id at all silently returned the newest page.
  it("400s a malformed `before` instead of letting the checkpointer throw", async () => {
    const { call } = await historyHandler();

    await expect(call({ before: { configurable: { checkpoint_id: 123 } } })).rejects.toMatchObject({
      status: 400,
    });
    await expect(call({ before: { configurable: {} } })).rejects.toMatchObject({ status: 400 });
    await expect(call({ before: "" })).rejects.toMatchObject({ status: 400 });
  });

  // The thread scope is server-owned. Only the checkpoint id is forwarded, so a `thread_id` smuggled in
  // `before.configurable` cannot redirect the read at another thread's checkpoints.
  it("forwards only the checkpoint id, dropping anything else in `before.configurable`", async () => {
    const { call, calls } = await historyHandler();

    await call({
      before: { configurable: { checkpoint_id: "c-1", thread_id: "someone-elses-thread" } },
    });

    expect(calls).toEqual([
      { limit: DEFAULT_THREAD_HISTORY_LIMIT, before: { configurable: { checkpoint_id: "c-1" } } },
    ]);
  });

  // `checkpoint` has no `getStateHistory` equivalent, but the SDK always sends the key — rejecting it
  // would 400 every single call.
  it("tolerates the SDK's `checkpoint` field", async () => {
    const { call, calls } = await historyHandler();

    await call({ checkpoint: { checkpoint_ns: "" } });

    expect(calls).toEqual([{ limit: DEFAULT_THREAD_HISTORY_LIMIT }]);
  });
});
