// `POST /threads/{id}/history` reads its options from the **body**, which is where the LangGraph SDK
// puts them (`json: { limit, before, metadata, checkpoint }`, limit defaulting to 10). Reading `?limit`
// instead meant a real client's limit was silently dropped and the endpoint drained the thread's whole
// checkpoint history — so these assert on the request shape, not just on the response length.

import { isSkeinHttpError, SkeinHttpError, type RunEventBus } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { createFixtureDeps, createFixtureResolver } from "./__fixtures__/deps.js";
import { createContext } from "./context.js";
import {
  createProtocolHandlers,
  type ProtocolRequest,
  type ProtocolResponse,
} from "./create-handlers.js";
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

describe("listThreadRuns pagination", () => {
  async function threadWithRuns(count: number) {
    const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
    await service.assistants.registerGraphAssistants();
    const handlers = createProtocolHandlers(service);
    const thread = await service.threads.create();
    for (let index = 0; index < count; index += 1) {
      await service.runs.createWait({
        thread_id: thread.thread_id,
        assistant_id: "echo",
        input: { value: `run ${index}` },
      });
    }
    const list = async (query: Record<string, string>) =>
      handlers.listThreadRuns({
        ...request(),
        params: { thread_id: thread.thread_id },
        query,
      });
    return { list };
  }

  it("clamps an over-ceiling limit instead of rejecting it", async () => {
    // Every other query-string limit in this table clamps — `positiveIntQuery` says so in its
    // docstring, and a caller asking for more than the ceiling wants as much as it can get. Rejecting
    // here would make the one paginated GET in the protocol behave unlike all its siblings.
    const { list } = await threadWithRuns(3);

    const huge = await list({ limit: "5000" });
    expect(huge.status).toBe(200);
    expect((huge as { body: unknown[] }).body).toHaveLength(3);

    // Garbage and a negative offset read as absent rather than as a 4xx.
    expect((await list({ limit: "abc" })).status).toBe(200);
    expect((await list({ offset: "-1" })).status).toBe(200);
  });

  it("pages with limit and offset", async () => {
    const { list } = await threadWithRuns(4);

    const first = (await list({ limit: "2" })) as { body: Array<{ run_id: string }> };
    const second = (await list({ limit: "2", offset: "2" })) as {
      body: Array<{ run_id: string }>;
    };

    expect(first.body).toHaveLength(2);
    expect(second.body).toHaveLength(2);
    expect(second.body.map((run) => run.run_id)).not.toEqual(first.body.map((run) => run.run_id));
  });
});

describe("pagination response metadata", () => {
  it("reports the unpaginated assistant total in a transport-neutral response header", async () => {
    const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
    await service.assistants.registerGraphAssistants();
    const response = await createProtocolHandlers(service).searchAssistants({
      ...request(),
      body: { limit: 1 },
    });

    expect(response.kind).toBe("json");
    expect(response.headers?.["x-pagination-total"]).toBe("6");
  });
});

/** The decoded body of a JSON response — `ProtocolResponse` is a union, so it needs narrowing. */
const jsonBody = (response: ProtocolResponse): unknown => {
  if (response.kind !== "json") throw new Error(`expected a json response, got "${response.kind}"`);
  return response.body;
};

/** A service + handlers over the fixture graphs, with the graph assistants registered. */
async function fixtureHandlers() {
  const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
  await service.assistants.registerGraphAssistants();
  return { service, handlers: createProtocolHandlers(service) };
}

describe("joinRun", () => {
  it("returns the settled run's final state", async () => {
    const { service, handlers } = await fixtureHandlers();
    const thread = await service.threads.create();
    const { runId } = await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });

    const response = await handlers.joinRun({
      ...request(),
      method: "get",
      params: { thread_id: thread.thread_id, run_id: runId },
    });

    expect(response.status).toBe(200);
    expect(jsonBody(response)).toEqual({ value: "echo: hi" });
  });

  it("answers a terminal run whose frames the bus has already forgotten", async () => {
    // The guard that makes this work is not an optimization. Both buses remember a closed run for 24h
    // and then drop it; past that window `subscribe` treats the id as a run that has not started and
    // waits forever. Modelled here by a bus that never yields for a forgotten run — so a handler that
    // subscribed unconditionally would hang, and this test would time out rather than pass.
    const neverSettles = new Promise<never>(() => undefined);
    const forgetfulBus: RunEventBus = {
      publish: async () => undefined,
      close: async () => undefined,
      subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => neverSettles }) }),
    };
    const service = createProtocolServiceFromContext(
      createContext(createFixtureDeps({ bus: forgetfulBus })),
    );
    await service.assistants.registerGraphAssistants();
    const handlers = createProtocolHandlers(service);
    const thread = await service.threads.create();
    const { runId } = await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });

    const response = await handlers.joinRun({
      ...request(),
      method: "get",
      params: { thread_id: thread.thread_id, run_id: runId },
    });

    expect(response.status).toBe(200);
    expect(jsonBody(response)).toEqual({ value: "echo: hi" });
  });

  it("reports a failed run as __error__ rather than an empty success", async () => {
    const { service, handlers } = await fixtureHandlers();
    const thread = await service.threads.create();
    const { runId } = await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "throwing",
      input: { value: "hi" },
    });

    const response = await handlers.joinRun({
      ...request(),
      method: "get",
      params: { thread_id: thread.thread_id, run_id: runId },
    });

    // Asserted on the *value*: `Run.error` is optional, and `{ __error__: undefined }` serializes to
    // `{}` — an empty success, exactly what this envelope exists to prevent.
    expect(jsonBody(response)).toMatchObject({ __error__: { message: expect.any(String) } });
  });

  it("answers with state, not a 404, when the run row is deleted while the join waits", async () => {
    // `cancel?action=rollback` and `on_completion: "delete"` both delete the row out from under a
    // join. The caller waited successfully, so the *settled-row re-read* 404ing must not become the
    // response. Modelled by letting the first read (the ownership gate) succeed and the second — the
    // one after the wait — find the row gone.
    const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();
    const { runId } = await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });

    let reads = 0;
    const handlers = createProtocolHandlers({
      ...service,
      runs: {
        ...service.runs,
        get: async (id: string) => {
          reads += 1;
          if (reads > 1) throw SkeinHttpError.notFound(`Run "${id}" not found.`);
          return service.runs.get(id);
        },
      },
    });

    const response = await handlers.joinRun({
      ...request(),
      method: "get",
      params: { thread_id: thread.thread_id, run_id: runId },
    });

    expect(reads).toBe(2); // the gate read plus the settled re-read
    expect(response.status).toBe(200);
    expect(jsonBody(response)).toEqual({ value: "echo: hi" });
  });

  it("404s for a run that does not exist", async () => {
    const { service, handlers } = await fixtureHandlers();
    const thread = await service.threads.create();

    await expect(
      handlers.joinRun({
        ...request(),
        method: "get",
        params: { thread_id: thread.thread_id, run_id: "nope" },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("ignores ?cancel_on_disconnect instead of rejecting it", async () => {
    const { service, handlers } = await fixtureHandlers();
    const thread = await service.threads.create();
    const { runId } = await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });

    const response = await handlers.joinRun({
      ...request(),
      method: "get",
      params: { thread_id: thread.thread_id, run_id: runId },
      query: { cancel_on_disconnect: "1" },
    });

    expect(response.status).toBe(200);
  });
});

describe("getThreadStateAtCheckpointFromBody", () => {
  it("reads state at the checkpoint named in the body", async () => {
    const { service, handlers } = await fixtureHandlers();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });
    const tip = await service.threads.getState(thread.thread_id);
    const checkpointId = tip.checkpoint?.checkpoint_id;
    expect(checkpointId).toBeTypeOf("string");

    const response = await handlers.getThreadStateAtCheckpointFromBody({
      ...request(),
      params: { thread_id: thread.thread_id },
      body: { checkpoint: { checkpoint_id: checkpointId } },
    });

    expect(response.status).toBe(200);
    expect(jsonBody(response)).toMatchObject({ values: tip.values });
  });

  it("falls back to the thread tip when the checkpoint pointer carries no id", async () => {
    // `@langchain/langgraph-api` spreads the pointer into `configurable` and lets the checkpointer
    // resolve the tip, so an absent/blank pointer means "current state", not a 404.
    const { service, handlers } = await fixtureHandlers();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });
    const tip = await service.threads.getState(thread.thread_id);

    for (const body of [{}, { checkpoint: null }, { checkpoint: {} }]) {
      const response = await handlers.getThreadStateAtCheckpointFromBody({
        ...request(),
        params: { thread_id: thread.thread_id },
        body,
      });
      expect(jsonBody(response)).toMatchObject({ values: tip.values });
    }
  });

  it("forwards checkpoint_ns, which is the only reason the SDK routes an object here", async () => {
    // A subgraph pointer must not silently read the root graph's state. Asserted on the config the
    // graph actually receives, since both namespaces return a 200 either way.
    const seen: Array<Record<string, unknown> | undefined> = [];
    const inner = createFixtureResolver();
    const recording: GraphResolver = {
      ...inner,
      load: async (graphId) => {
        const graph = await inner.load(graphId);
        return new Proxy(graph as object, {
          get(target, property, receiver) {
            if (property !== "getState") return Reflect.get(target, property, receiver);
            return (config: { configurable?: Record<string, unknown> }) => {
              seen.push(config.configurable);
              return (target as { getState: (c: unknown) => unknown }).getState(config);
            };
          },
        }) as ResolvedGraph;
      },
    };
    const service = createProtocolServiceFromContext(
      createContext(createFixtureDeps({ graphs: recording })),
    );
    await service.assistants.registerGraphAssistants();
    const handlers = createProtocolHandlers(service);
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });
    seen.length = 0;

    await handlers.getThreadStateAtCheckpointFromBody({
      ...request(),
      params: { thread_id: thread.thread_id },
      body: { checkpoint: { checkpoint_id: "c-1", checkpoint_ns: "child:abc" } },
    });

    expect(seen).toEqual([
      { thread_id: thread.thread_id, checkpoint_ns: "child:abc", checkpoint_id: "c-1" },
    ]);
  });

  it("accepts and ignores `subgraphs`, which the SDK always sends", async () => {
    const { service, handlers } = await fixtureHandlers();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });

    const response = await handlers.getThreadStateAtCheckpointFromBody({
      ...request(),
      params: { thread_id: thread.thread_id },
      body: { checkpoint: null, subgraphs: true },
    });

    expect(response.status).toBe(200);
  });
});

// The store endpoints had no handler test at all, which is how three separate defects survived: a
// `filter` that validated and was then dropped, `suffix`/`max_depth` that were never even declared,
// and a response shape the official SDK client cannot read.
describe("store handlers", () => {
  /** The JSON body of a response, narrowed off the `ProtocolResponse` union. */
  const bodyOf = (response: ProtocolResponse): unknown => {
    if (response.kind !== "json") throw new Error(`expected a json response, got ${response.kind}`);
    return response.body;
  };

  const seed = async (handlers: ReturnType<typeof createProtocolHandlers>) => {
    for (const [namespace, key, value] of [
      [["users", "1", "facts"], "a", { topic: "coffee", score: 5 }],
      [["users", "2", "facts"], "b", { topic: "tea", score: 2 }],
      [["orgs", "acme"], "c", { topic: "billing", score: 9 }],
    ] as const) {
      await handlers.putStoreItem({ ...request(), body: { namespace, key, value } });
    }
  };

  it("wraps search results in { items }, the way the SDK reads them", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    const response = await handlers.searchStoreItems({ ...request(), body: {} });

    // A bare array made `client.store.searchItems()` throw on `.items.map`.
    expect(bodyOf(response)).toMatchObject({ items: expect.any(Array) });
    expect((bodyOf(response) as { items: unknown[] }).items).toHaveLength(3);
  });

  it("wraps namespaces in { namespaces }", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    const response = await handlers.listStoreNamespaces({ ...request(), body: {} });

    // A bare array here failed *silently*: `result.namespaces` was simply undefined.
    expect(bodyOf(response)).toEqual({
      namespaces: [
        ["orgs", "acme"],
        ["users", "1", "facts"],
        ["users", "2", "facts"],
      ],
    });
  });

  // The SDK's two single-item methods disagree about transport on the same path: `getItem` sends
  // `?namespace=a.b&key=…`, `deleteItem` sends a JSON body with `namespace` already an array. Reading
  // only the query made every SDK delete a silent no-op — and silent is the problem, since `deleteItem`
  // returns void, so nothing surfaced.
  it("deletes from a JSON body, the way the SDK's deleteItem sends it", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    const response = await handlers.deleteStoreItem({
      ...request(),
      method: "DELETE",
      body: { namespace: ["users", "1", "facts"], key: "a" },
    });

    expect(response.kind).toBe("empty");
    const remaining = await handlers.searchStoreItems({ ...request(), body: {} });
    expect((bodyOf(remaining) as { items: unknown[] }).items).toHaveLength(2);
  });

  it("still deletes from query params, which is what a hand-rolled caller sends", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    await handlers.deleteStoreItem({
      ...request(),
      method: "DELETE",
      query: { namespace: "users.1.facts", key: "a" },
    });

    const remaining = await handlers.searchStoreItems({ ...request(), body: {} });
    expect((bodyOf(remaining) as { items: unknown[] }).items).toHaveLength(2);
  });

  it("accepts a dot-joined namespace in the body, so the two transports name the same namespace", async () => {
    // Accepting only an array here would fall through to an absent query param — an empty namespace,
    // deleting nothing, answering 204: the same silent no-op, one shape further along.
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    await handlers.deleteStoreItem({
      ...request(),
      method: "DELETE",
      body: { namespace: "users.1.facts", key: "a" },
    });

    const remaining = await handlers.searchStoreItems({ ...request(), body: {} });
    expect((bodyOf(remaining) as { items: unknown[] }).items).toHaveLength(2);
  });

  it("refuses a malformed namespace with a 400 instead of deleting nothing and answering 204", async () => {
    // Two failures in one: `["users", 1, "facts"]` must not be filtered down to `["users","facts"]` (a
    // namespace the caller never named), and it must not read as absent and then quietly delete nothing.
    // A numeric segment is easy to hit with a numeric user id, and `deleteItem` returns void, so a 204
    // surfaces nothing at all. `putStoreItem` already 400s on the same input via Zod.
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    await expect(
      handlers.deleteStoreItem({
        ...request(),
        method: "DELETE",
        body: { namespace: ["users", 1, "facts"], key: "a" },
      }),
    ).rejects.toSatisfy((error: unknown) => isSkeinHttpError(error) && error.status === 400);

    const remaining = await handlers.searchStoreItems({ ...request(), body: {} });
    expect((bodyOf(remaining) as { items: unknown[] }).items).toHaveLength(3);
  });

  it("refuses a store read or delete that names no namespace at all", async () => {
    // Nothing can be written at the root (`storePutSchema` requires a segment), so a request naming it
    // is unsatisfiable rather than empty.
    const { handlers } = await fixtureHandlers();

    for (const call of [
      handlers.getStoreItem({ ...request(), query: { key: "a" } }),
      handlers.deleteStoreItem({ ...request(), method: "DELETE", query: { key: "a" } }),
    ]) {
      await expect(call).rejects.toSatisfy(
        (error: unknown) => isSkeinHttpError(error) && error.status === 400,
      );
    }
  });

  it("reads a get from a body namespace too, so both single-item routes accept both shapes", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    const response = await handlers.getStoreItem({
      ...request(),
      body: { namespace: ["orgs", "acme"], key: "c" },
    });

    expect(bodyOf(response)).toMatchObject({ key: "c", value: { topic: "billing" } });
  });

  it("emits store item timestamps as created_at/updated_at", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    const put = await handlers.putStoreItem({
      ...request(),
      body: { namespace: ["users", "1"], key: "profile", value: { name: "Ada" } },
    });
    const got = await handlers.getStoreItem({
      ...request(),
      query: { namespace: "users.1", key: "profile" },
    });

    // The SDK maps `created_at → createdAt` on read, so camelCase on the wire meant every item came
    // back through the official client with undefined timestamps.
    for (const body of [bodyOf(put), bodyOf(got)]) {
      expect(body).toMatchObject({
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
      expect(body).not.toHaveProperty("createdAt");
    }
  });

  it("narrows a search by filter", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    const response = await handlers.searchStoreItems({
      ...request(),
      body: { filter: { score: { $gt: 3 } } },
    });

    const items = (bodyOf(response) as { items: { key: string }[] }).items;
    expect(items.map((item) => item.key).sort()).toEqual(["a", "c"]);
  });

  it("honours suffix and max_depth on listNamespaces", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    const suffixed = await handlers.listStoreNamespaces({
      ...request(),
      body: { suffix: ["facts"] },
    });
    expect(bodyOf(suffixed)).toEqual({
      namespaces: [
        ["users", "1", "facts"],
        ["users", "2", "facts"],
      ],
    });

    const shallow = await handlers.listStoreNamespaces({ ...request(), body: { max_depth: 1 } });
    expect(bodyOf(shallow)).toEqual({ namespaces: [["orgs"], ["users"]] });
  });

  it("narrows a wildcard namespace prefix instead of returning every namespace", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    const response = await handlers.listStoreNamespaces({
      ...request(),
      body: { prefix: ["users", "*"] },
    });

    expect(bodyOf(response)).toEqual({
      namespaces: [
        ["users", "1", "facts"],
        ["users", "2", "facts"],
      ],
    });
  });

  it("refuses an unknown filter operator rather than silently widening the search", async () => {
    const { handlers } = await fixtureHandlers();

    // A typo'd `$gte` would otherwise parse as a bag stating no conditions — matching everything.
    await expect(
      handlers.searchStoreItems({ ...request(), body: { filter: { score: { $gtt: 3 } } } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a non-scalar filter value rather than silently matching nothing", async () => {
    const { handlers } = await fixtureHandlers();

    await expect(
      handlers.searchStoreItems({ ...request(), body: { filter: { tags: ["a"] } } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an ordering operand Postgres could not cast", async () => {
    const { handlers } = await fixtureHandlers();

    // `'abc'::numeric` throws, so an unchecked operand here is a 500 rather than an empty result.
    await expect(
      handlers.searchStoreItems({ ...request(), body: { filter: { score: { $gt: "3" } } } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("bounds max_depth, which binds into an int4 array subscript", async () => {
    const { handlers } = await fixtureHandlers();

    // Unbounded, this overflows Postgres' subscript type and 500s where it should 400.
    await expect(
      handlers.listStoreNamespaces({ ...request(), body: { max_depth: Number.MAX_SAFE_INTEGER } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts and ignores refresh_ttl, which the SDK always sends", async () => {
    const { handlers } = await fixtureHandlers();
    await seed(handlers);

    const response = await handlers.searchStoreItems({
      ...request(),
      body: { refresh_ttl: true },
    });

    expect(response.status).toBe(200);
  });

  it("defaults the namespace page when the body names no limit", async () => {
    const { service } = await fixtureHandlers();
    const seen: unknown[] = [];
    const listNamespaces = service.store.listNamespaces.bind(service.store);
    service.store.listNamespaces = async (query) => {
      seen.push(query);
      return listNamespaces(query);
    };

    await createProtocolHandlers(service).listStoreNamespaces({ ...request(), body: {} });

    // Unbounded before: this endpoint used to return every namespace in the store.
    expect(seen).toEqual([{ limit: 100 }]);
  });
});
