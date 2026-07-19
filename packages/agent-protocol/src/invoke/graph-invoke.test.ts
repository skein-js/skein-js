// The simplified single-graph invoke surface: raw body in / final state out, opt-in SSE, unknown
// graph 404s, and — the one that matters most — the auth gate is NOT bypassed, since invoking a
// graph runs it. Also pins the two properties that define "simplified": calls are independent (no
// thread state leaks between them) and the long-term store is still reachable via `getStore()`.

import { SkeinHttpError, isSkeinHttpError, type AuthEngine } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { createFixtureDeps, collect } from "../__fixtures__/deps.js";
import type { ProtocolRequest, ProtocolResponse } from "../create-handlers.js";
import type { ProtocolDeps } from "../deps.js";

import { createGraphInvokeHandler, graphInvokeRoutes } from "./graph-invoke.js";

/** A `ProtocolRequest` targeting `graph_id`, with the body as the graph input. */
function invokeReq(graphId: string, body: unknown, overrides: Partial<ProtocolRequest> = {}) {
  return {
    method: "POST",
    url: `http://localhost:2024/invoke/${graphId}`,
    params: { graph_id: graphId },
    query: {},
    body,
    headers: {},
    ...overrides,
  } satisfies ProtocolRequest;
}

const asStream = (graphId: string, body: unknown, query: ProtocolRequest["query"] = {}) =>
  invokeReq(graphId, body, { headers: { accept: "text/event-stream" }, query });

/** An engine that reads the caller from `x-user`; `deny` forces a 403. */
function fakeEngine(options: { deny?: boolean } = {}): AuthEngine {
  return {
    enabled: true,
    studioAuthDisabled: false,
    authenticate: async (request) => {
      const identity = request.headers.get("x-user");
      if (!identity) throw SkeinHttpError.unauthorized("missing credentials");
      return {
        user: { identity, display_name: identity, is_authenticated: true, permissions: [] },
        scopes: [],
      };
    },
    authorize: async ({ value }) => {
      if (options.deny) throw SkeinHttpError.forbidden("denied");
      return { filters: undefined, value };
    },
    matchesFilters: () => true,
  };
}

const jsonBody = (response: ProtocolResponse): unknown => {
  if (response.kind !== "json") throw new Error(`expected a json response, got "${response.kind}"`);
  return response.body;
};

const sseText = async (response: ProtocolResponse): Promise<string> => {
  if (response.kind !== "sse") throw new Error(`expected an sse response, got "${response.kind}"`);
  return (await collect(response.events)).join("");
};

describe("createGraphInvokeHandler", () => {
  it("returns the graph's final state, with the request body as the input", async () => {
    const invoke = createGraphInvokeHandler(createFixtureDeps());

    const response = await invoke(invokeReq("echo", { value: "hi" }));

    expect(response.status).toBe(200);
    expect(jsonBody(response)).toMatchObject({ value: "echo: hi" });
  });

  it("404s an unregistered graph id", async () => {
    const invoke = createGraphInvokeHandler(createFixtureDeps());

    await expect(invoke(invokeReq("nope", {}))).rejects.toMatchObject({
      status: 404,
      code: "graph_not_found",
    });
  });

  // An absent body must not surface LangGraph's opaque `EmptyInputError`; it runs the state defaults.
  it("runs the graph with its default state when the body is empty", async () => {
    const invoke = createGraphInvokeHandler(createFixtureDeps());

    const response = await invoke(invokeReq("echo", undefined));

    expect(jsonBody(response)).toMatchObject({ value: "echo: " });
  });

  it("propagates a graph failure as an error on the JSON path", async () => {
    const invoke = createGraphInvokeHandler(createFixtureDeps());

    await expect(invoke(invokeReq("throwing", { value: "x" }))).rejects.toThrow("boom");
  });

  it("keeps calls independent — no thread state carries over", async () => {
    const invoke = createGraphInvokeHandler(createFixtureDeps());

    const first = jsonBody(await invoke(invokeReq("echo", { value: "one" })));
    const second = jsonBody(await invoke(invokeReq("echo", { value: "two" })));

    expect(first).toMatchObject({ value: "echo: one" });
    expect(second).toMatchObject({ value: "echo: two" });
  });

  // Resolvers memoize a non-factory export, so every caller shares one CompiledGraph. If invoke
  // attached its throwaway saver to that shared instance, a concurrent protocol run would pick it up
  // and silently write thread state to a discarded in-memory saver instead of the durable one.
  it("never mutates the shared compiled graph the run engine relies on", async () => {
    const deps = createFixtureDeps();
    const shared = (await deps.graphs.load("echo")) as { checkpointer?: unknown; store?: unknown };
    shared.checkpointer = deps.checkpointer;
    const durableStore = shared.store;

    await createGraphInvokeHandler(deps)(invokeReq("echo", { value: "hi" }));

    expect(shared.checkpointer).toBe(deps.checkpointer);
    expect(shared.store).toBe(durableStore);
  });

  // Without a signal a hung graph would hold the request open forever, burning tokens for nobody.
  it("aborts a hung graph once deps.runTimeoutMs elapses", async () => {
    const invoke = createGraphInvokeHandler(createFixtureDeps({ runTimeoutMs: 50 }));

    await expect(invoke(invokeReq("slow", { value: "x" }))).rejects.toThrow();
  });

  it("aborts when the caller's own signal fires (client disconnect)", async () => {
    const invoke = createGraphInvokeHandler(createFixtureDeps());
    const disconnected = new AbortController();
    setTimeout(() => disconnected.abort(new Error("client disconnected")), 50);

    await expect(
      invoke({ ...invokeReq("slow", { value: "x" }), signal: disconnected.signal }),
    ).rejects.toThrow();
  });

  it("still injects the long-term store, so nodes reach getStore()", async () => {
    const invoke = createGraphInvokeHandler(createFixtureDeps());

    const response = await invoke(invokeReq("store", { value: "remembered" }));

    expect(jsonBody(response)).toMatchObject({ value: "stored: remembered" });
  });

  describe("streaming", () => {
    it("streams SSE when the caller sends Accept: text/event-stream", async () => {
      const invoke = createGraphInvokeHandler(createFixtureDeps());

      const text = await sseText(await invoke(asStream("echo", { value: "hi" })));

      expect(text).toContain("event: values");
      expect(text).toContain("echo: hi");
      expect(text.trimEnd().endsWith(`data: {"status":"success"}`)).toBe(true);
    });

    it("reports a mid-stream failure as an error frame, not a terminal end", async () => {
      const invoke = createGraphInvokeHandler(createFixtureDeps());

      const text = await sseText(await invoke(asStream("throwing", { value: "x" })));

      expect(text).toContain("event: error");
      expect(text).toContain("boom");
      expect(text).not.toContain(`"status":"success"`);
    });

    // `events` isn't a Pregel mode — it would filter down to an empty streamMode and stream nothing.
    it("rejects stream_mode=events with a 400 rather than streaming nothing", async () => {
      const invoke = createGraphInvokeHandler(createFixtureDeps());

      await expect(
        invoke(asStream("echo", { value: "hi" }, { stream_mode: "events" })),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("400s an unknown stream mode instead of failing deeper in LangGraph", async () => {
      const invoke = createGraphInvokeHandler(createFixtureDeps());

      await expect(
        invoke(asStream("echo", { value: "hi" }, { stream_mode: "garbage" })),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("honors a per-request ?stream_mode= override", async () => {
      const invoke = createGraphInvokeHandler(createFixtureDeps());

      const text = await sseText(
        await invoke(asStream("echo", { value: "hi" }, { stream_mode: "updates" })),
      );

      expect(text).toContain("event: updates");
      expect(text).not.toContain("event: values");
    });
  });

  describe("auth", () => {
    const authedDeps = (engine: AuthEngine): ProtocolDeps => createFixtureDeps({ auth: engine });

    it("401s an unauthenticated caller", async () => {
      const invoke = createGraphInvokeHandler(authedDeps(fakeEngine()));

      const failure = await invoke(invokeReq("echo", { value: "hi" })).catch((error) => error);

      expect(isSkeinHttpError(failure) && failure.status).toBe(401);
    });

    it("403s a caller the authorize handler denies", async () => {
      const invoke = createGraphInvokeHandler(authedDeps(fakeEngine({ deny: true })));

      const failure = await invoke(
        invokeReq("echo", { value: "hi" }, { headers: { "x-user": "ada" } }),
      ).catch((error) => error);

      expect(isSkeinHttpError(failure) && failure.status).toBe(403);
    });

    // Otherwise 404-vs-401 would let an anonymous caller enumerate which graph ids exist.
    it("401s an unknown graph id too, rather than leaking that it doesn't exist", async () => {
      const invoke = createGraphInvokeHandler(authedDeps(fakeEngine()));

      const failure = await invoke(invokeReq("nope", { value: "hi" })).catch((error) => error);

      expect(isSkeinHttpError(failure) && failure.status).toBe(401);
    });

    // The body is raw graph input, so without re-stamping, a body `graph_id` would shadow the path
    // param and let a policy authorize a different graph than the one that actually runs.
    it("judges the policy against the executed graph, not a body-supplied graph_id", async () => {
      const seen: unknown[] = [];
      const engine = fakeEngine();
      const spying: AuthEngine = {
        ...engine,
        authorize: async (input) => {
          seen.push((input.value as { graph_id?: unknown }).graph_id);
          return engine.authorize(input);
        },
      };
      const invoke = createGraphInvokeHandler(authedDeps(spying));

      await invoke(
        invokeReq(
          "echo",
          { value: "hi", graph_id: "some-other-graph" },
          { headers: { "x-user": "ada" } },
        ),
      );

      expect(seen).toEqual(["echo"]);
    });

    it("runs the graph for an authorized caller", async () => {
      const invoke = createGraphInvokeHandler(authedDeps(fakeEngine()));

      const response = await invoke(
        invokeReq("echo", { value: "hi" }, { headers: { "x-user": "ada" } }),
      );

      expect(jsonBody(response)).toMatchObject({ value: "echo: hi" });
    });
  });
});

describe("graphInvokeRoutes", () => {
  it("binds one POST at the default prefix", () => {
    expect(graphInvokeRoutes()).toEqual([
      { method: "post", path: "/invoke/:graph_id", handler: "invokeGraph" },
    ]);
  });

  it("accepts a custom prefix and tolerates a trailing slash", () => {
    expect(graphInvokeRoutes("/api/graphs/")[0]?.path).toBe("/api/graphs/:graph_id");
  });

  it("mounts at the root when the prefix is /", () => {
    expect(graphInvokeRoutes("/")[0]?.path).toBe("/:graph_id");
  });
});
