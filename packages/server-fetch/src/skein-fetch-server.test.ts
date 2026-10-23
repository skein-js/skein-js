import { Annotation, StateGraph } from "@langchain/langgraph";
import { embedInMemoryGraphs, loadConfigHttpHandler } from "@skein-js/server-kit";
import { describe, expect, it, vi } from "vitest";

import {
  createSkeinFetchServer,
  toFetchResponse,
  DEFAULT_MAX_BODY_BYTES,
} from "./skein-fetch-server.js";

const State = Annotation.Root({ value: Annotation<string>() });
const graph = new StateGraph(State)
  .addNode("echo", (state) => ({ value: `echo: ${state.value ?? ""}` }))
  .addEdge("__start__", "echo")
  .addEdge("echo", "__end__")
  .compile();

describe("toFetchResponse", () => {
  it("preserves protocol headers and lets transport headers take precedence", async () => {
    const response = toFetchResponse(
      {
        kind: "json",
        status: 200,
        body: { ok: true },
        headers: { "x-total-count": "12", vary: "accept" },
      },
      { vary: "origin" },
    );

    expect(response.headers.get("x-total-count")).toBe("12");
    expect(response.headers.get("vary")).toBe("origin");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("pulls SSE frames on demand and cancels the source on disconnect", async () => {
    let requestedFrames = 0;
    const released = vi.fn();
    async function* frames(): AsyncGenerator<string> {
      try {
        for (;;) {
          requestedFrames += 1;
          yield `data: ${requestedFrames}\n\n`;
        }
      } finally {
        released();
      }
    }

    const response = toFetchResponse({ kind: "sse", status: 200, events: frames() });
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // A Web stream may prefetch up to its high-water mark, but it must not drain the producer while
    // nobody is consuming it.
    await Promise.resolve();
    await Promise.resolve();
    expect(requestedFrames).toBeLessThanOrEqual(1);

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("data: 1\n\n");
    await reader?.cancel();
    expect(released).toHaveBeenCalledOnce();
  });

  it("does not emit a body for empty responses", async () => {
    const response = toFetchResponse({
      kind: "empty",
      status: 204,
      headers: { "x-total-count": "0" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("x-total-count")).toBe("0");
    expect(await response.text()).toBe("");
  });
});

describe("request body bound", () => {
  // Unlike the Node adapters, a native Fetch server inherits no body-parser limit: `Bun.serve`
  // defaults to 128MB and `Deno.serve` to nothing. The body is read before validation or auth, so an
  // unbounded read here is an unauthenticated OOM on a small container.
  it("refuses an oversized body without reading it, and streams the bound for a chunked one", async () => {
    const server = await createSkeinFetchServer({
      deps: embedInMemoryGraphs({ echo: graph }),
      maxBodyBytes: 64,
    });
    try {
      const declared = await server.fetch(
        new Request("http://localhost/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ metadata: { pad: "x".repeat(200) } }),
        }),
      );
      expect(declared.status).toBe(413);

      // No content-length: the count has to come from the stream, or the bound is bypassable by
      // simply not declaring a length.
      let pushed = 0;
      const chunked = await server.fetch(
        new Request("http://localhost/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              pushed += 1;
              controller.enqueue(new TextEncoder().encode("x".repeat(32)));
              if (pushed > 100) controller.close();
            },
          }),
          // @ts-expect-error — a streaming request body needs this flag, which the DOM types omit.
          duplex: "half",
        }),
      );
      expect(chunked.status).toBe(413);
      // Stopped early rather than draining the producer: 64 bytes is three 32-byte chunks at most.
      expect(pushed).toBeLessThan(5);

      const allowed = await server.fetch(
        new Request("http://localhost/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(allowed.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("defaults to express.json()'s limit, so adapters agree on the same request", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(100 * 1024);
  });
});

describe("createSkeinFetchServer", () => {
  it("dispatches a real protocol request through the Fetch boundary", async () => {
    const server = await createSkeinFetchServer({ deps: embedInMemoryGraphs({ echo: graph }) });
    try {
      const response = await server.fetch(
        new Request("http://localhost/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "idle" });
    } finally {
      await server.close();
    }
  });
});

it("completes terminal stream joins with a fresh completion marker and buffered replay", async () => {
  const deps = embedInMemoryGraphs({ echo: graph });
  const thread = await deps.store.threads.create();
  const run = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    status: "error",
  });
  await deps.bus.publish(run.run_id, { seq: 1, event: "values", data: { retained: true } });
  const server = await createSkeinFetchServer({ deps });
  try {
    const response = await server.fetch(
      new Request(`http://localhost/threads/${thread.thread_id}/runs/${run.run_id}/stream`, {
        signal: AbortSignal.timeout(2000),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"retained":true');
  } finally {
    await server.close();
  }
});

it("dispatches native Fetch applications before protocol routing without consuming fallthrough bodies", async () => {
  const deps = embedInMemoryGraphs({ echo: graph });
  deps.httpHandler = await loadConfigHttpHandler(
    { graphs: {}, http: { app: "./app.ts:app" } },
    {
      configDir: "/fixture",
      importModule: async () => ({
        app: async (request: Request) => {
          if (new URL(request.url).pathname === "/info")
            return new Response("custom", { status: 201 });
          await request.text();
          return new Response("missing", { status: 404 });
        },
      }),
    },
  );
  const server = await createSkeinFetchServer({ deps });
  try {
    const custom = await server.fetch(new Request("http://localhost/info"));
    expect(custom.status).toBe(201);
    expect(await custom.text()).toBe("custom");
    const thread = await server.fetch(
      new Request("http://localhost/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: { from: "fallback" } }),
      }),
    );
    expect(thread.status).toBe(200);
    expect(await thread.json()).toMatchObject({ metadata: { from: "fallback" } });
  } finally {
    await server.close();
  }
});

it("keeps protocol JSON readable after native authentication inspects its body", async () => {
  const deps = embedInMemoryGraphs(
    { echo: graph },
    {
      auth: {
        enabled: true,
        studioAuthDisabled: true,
        authenticate: async (request) => {
          expect(await request.json()).toEqual({ metadata: { from: "auth" } });
          return undefined;
        },
        authorize: async ({ value }) => ({ value }),
        matchesFilters: () => true,
      },
    },
  );
  deps.httpHandler = async () => undefined;
  const server = await createSkeinFetchServer({ deps });
  try {
    const thread = await server.fetch(
      new Request("http://localhost/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: { from: "auth" } }),
      }),
    );
    expect(thread.status).toBe(200);
    expect(await thread.json()).toMatchObject({ metadata: { from: "auth" } });
  } finally {
    await server.close();
  }
});
