import type { AuthEngine, AuthFilters, Metadata } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createAuthScopedStore } from "../auth/auth-scoped-store.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

const ownerEngine = {
  matchesFilters: (metadata: Metadata | undefined, filters: AuthFilters) =>
    metadata?.["owner"] === filters["owner"],
  stampFromFilters: (metadata: Metadata | undefined, filters: AuthFilters) => ({
    ...metadata,
    ...filters,
  }),
} as unknown as AuthEngine;

it("filters namespaces and caller visibility during replay and live delivery", async () => {
  const deps = createFixtureDeps();
  const thread = await deps.store.threads.create({ metadata: { owner: "alice" } });
  const mine = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    metadata: { owner: "alice" },
  });
  const theirs = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    metadata: { owner: "bob" },
  });
  const publish = (runId: string, namespace: string[], value: string) =>
    deps.threadBus!.publish(thread.thread_id, {
      kind: "protocol",
      runId,
      event: {
        type: "event",
        method: "values",
        params: { namespace, timestamp: Date.now(), data: { value } },
      },
    });
  await publish(theirs.run_id, ["child:1"], "hidden replay");
  await publish(mine.run_id, ["other:1"], "wrong namespace");
  await publish(mine.run_id, ["child:1"], "visible replay");
  const service = createProtocolServiceFromContext(
    createContext({
      ...deps,
      store: createAuthScopedStore(deps.store, ownerEngine, { owner: "alice" }, "threads"),
    }),
  );
  const controller = new AbortController();
  const stream = await service.threadStream.subscribe!(
    thread.thread_id,
    { channels: ["values"], namespaces: [["child"]], depth: 0, since: 0 },
    controller.signal,
  );
  const iterator = stream[Symbol.asyncIterator]();
  try {
    expect((await iterator.next()).value).toContain(": subscribed");
    expect((await iterator.next()).value).toContain("visible replay");
    await publish(theirs.run_id, ["child:2"], "hidden live");
    await publish(mine.run_id, ["child:2", "nested:1"], "too deep");
    await publish(mine.run_id, ["child:2"], "visible live");
    expect((await iterator.next()).value).toContain("visible live");
  } finally {
    controller.abort();
    await iterator.return?.();
  }
});

it("replays retained publication order before a current state baseline for late selectors", async () => {
  const deps = createFixtureDeps();
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  const thread = await service.threads.create();
  const result = await service.runs.createWait({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    input: { value: "saved" },
  });
  for (const value of ["earlier", "later"])
    await deps.threadBus!.publish(thread.thread_id, {
      kind: "protocol",
      runId: result.runId,
      event: {
        type: "event",
        method: "values",
        params: { namespace: [], timestamp: 0, data: { value } },
      },
    });
  const stopped = new AbortController();
  const stream = await service.threadStream.subscribe!(
    thread.thread_id,
    { channels: ["values"] },
    stopped.signal,
  );
  const iterator = stream[Symbol.asyncIterator]();
  try {
    await iterator.next();
    const frames = [];
    for (let index = 0; index < 3; index++) frames.push(String((await iterator.next()).value));
    expect(frames[0]).toContain("earlier");
    expect(frames[1]).toContain("later");
    expect(frames[2]).toContain("echo: saved");
    const sequences = frames.map((frame) => Number(/^id: (\d+)/.exec(frame)![1]));
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  } finally {
    stopped.abort();
    await iterator.return?.();
  }
});

describe("thread command envelopes", () => {
  it("returns correlated protocol errors without creating runs", async () => {
    const deps = createFixtureDeps();
    const service = createProtocolServiceFromContext(createContext(deps));
    const thread = await service.threads.create();
    expect(
      await service.threadStream.protocolCommand!(thread.thread_id, {
        id: 7,
        method: "unknown",
        params: {},
      }),
    ).toMatchObject({ type: "error", id: 7, error: "unknown_command" });
    expect(
      await service.threadStream.protocolCommand!(thread.thread_id, {
        id: 8,
        method: "input.inject",
        params: {},
      }),
    ).toMatchObject({ type: "error", id: 8, error: "not_supported" });
    expect(await deps.store.runs.listByThread(thread.thread_id)).toEqual([]);
  });
});

it("does not send a stale baseline if a thread incarnation changes during state capture", async () => {
  const deps = createFixtureDeps();
  const context = createContext(deps);
  const service = createProtocolServiceFromContext(context);
  await service.assistants.registerGraphAssistants();
  const thread = await service.threads.create();
  await service.runs.createWait({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    input: { value: "private" },
  });
  const original = deps.graphs.load;
  let captured!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.graphs.load = async (id) => {
    const graph = await original(id);
    if (typeof graph === "function") throw new Error("Expected fixture graph.");
    const wrapped = Object.create(graph) as typeof graph;
    wrapped.getState = async function (config, options) {
      const snapshot = await graph.getState!.call(this, config, options);
      captured();
      await held;
      return snapshot;
    };
    return wrapped;
  };
  const subscribed = service.threadStream.subscribe!(thread.thread_id, { channels: ["values"] });
  await entered;
  await deps.threadBus!.deleteThread(thread.thread_id);
  await deps.threadBus!.publish(thread.thread_id, { kind: "state", operation: "created", thread });
  release();
  const iterator = (await subscribed)[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(true);
  expect(context.threadStreams?.size).toBe(0);
});
