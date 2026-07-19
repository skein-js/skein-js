// End-to-end adapter tests over real HTTP (native `fetch` against an ephemeral server): one per
// response shape the transport shim produces — JSON, 204, error mapping, and SSE — plus CORS.

import { afterEach, describe, expect, it } from "vitest";

import { startEchoServer, type RunningServer } from "./__fixtures__/echo-server.js";

const jsonHeaders = { "content-type": "application/json" };

describe("@skein-js/express adapter", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("serves JSON: round-trips a thread and lists the graph-seeded assistant", async () => {
    running = await startEchoServer();
    const { baseUrl } = running;

    const createRes = await fetch(`${baseUrl}/threads`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    expect(createRes.status).toBe(200);
    const thread = (await createRes.json()) as { thread_id: string };
    expect(typeof thread.thread_id).toBe("string");

    const getRes = await fetch(`${baseUrl}/threads/${thread.thread_id}`);
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { thread_id: string }).thread_id).toBe(thread.thread_id);

    const searchRes = await fetch(`${baseUrl}/assistants/search`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    const assistants = (await searchRes.json()) as Array<{
      assistant_id: string;
      graph_id: string;
    }>;
    expect(assistants).toContainEqual(
      expect.objectContaining({ assistant_id: "echo", graph_id: "echo" }),
    );
  });

  it("runs the assistant CRUD + versioning lifecycle over HTTP", async () => {
    running = await startEchoServer();
    const { baseUrl } = running;
    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });

    // Create.
    const createRes = await post("/assistants", {
      graph_id: "echo",
      assistant_id: "custom",
      metadata: { env: "dev" },
    });
    expect(createRes.status).toBe(200);
    expect((await createRes.json()) as { version: number }).toMatchObject({
      assistant_id: "custom",
      graph_id: "echo",
      version: 1,
    });

    // if_exists defaults to raise → 409 on a duplicate id.
    expect((await post("/assistants", { graph_id: "echo", assistant_id: "custom" })).status).toBe(
      409,
    );

    // Update mints version 2.
    const patchRes = await fetch(`${baseUrl}/assistants/custom`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ metadata: { env: "prod" } }),
    });
    expect(((await patchRes.json()) as { version: number }).version).toBe(2);

    // Version history, newest-first.
    const versions = (await (await post("/assistants/custom/versions", {})).json()) as Array<{
      version: number;
    }>;
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    // Roll back to v1.
    const rolledBack = (await (await post("/assistants/custom/latest", { version: 1 })).json()) as {
      version: number;
      metadata: Record<string, unknown>;
    };
    expect(rolledBack).toMatchObject({ version: 1, metadata: { env: "dev" } });

    // Count (echo seeded + custom on graph "echo").
    const count = (await (await post("/assistants/count", { graph_id: "echo" })).json()) as number;
    expect(count).toBe(2);

    // Delete → 204, then gone.
    const deleteRes = await fetch(`${baseUrl}/assistants/custom`, { method: "DELETE" });
    expect(deleteRes.status).toBe(204);
    expect((await fetch(`${baseUrl}/assistants/custom`)).status).toBe(404);
  });

  it("serves the drawable graph and (empty) subgraphs for an assistant", async () => {
    running = await startEchoServer();
    const { baseUrl } = running;

    const graph = (await (await fetch(`${baseUrl}/assistants/echo/graph`)).json()) as {
      nodes: Array<{ id: string }>;
      edges: unknown[];
    };
    expect(graph.nodes.some((node) => node.id === "echo")).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);

    const subgraphs = await (await fetch(`${baseUrl}/assistants/echo/subgraphs`)).json();
    expect(subgraphs).toEqual({});
  });

  it("serves a dependency-free liveness probe at /ok", async () => {
    running = await startEchoServer();
    const res = await fetch(`${running.baseUrl}/ok`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 204 with an empty body on delete", async () => {
    running = await startEchoServer();
    const { baseUrl } = running;

    const thread = (await (
      await fetch(`${baseUrl}/threads`, { method: "POST", headers: jsonHeaders, body: "{}" })
    ).json()) as { thread_id: string };

    const deleteRes = await fetch(`${baseUrl}/threads/${thread.thread_id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(204);
    expect(await deleteRes.text()).toBe("");
  });

  it("maps SkeinHttpError to its status (404) and Zod failures to 400", async () => {
    running = await startEchoServer();
    const { baseUrl } = running;

    const missingRes = await fetch(`${baseUrl}/assistants/does-not-exist`);
    expect(missingRes.status).toBe(404);
    const missingBody = (await missingRes.json()) as { status: number; message: string };
    expect(missingBody.status).toBe(404);
    expect(typeof missingBody.message).toBe("string");

    // Missing the required `assistant_id` → boundary validation → 400.
    const badRes = await fetch(`${baseUrl}/runs/wait`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    expect(badRes.status).toBe(400);
  });

  it("time travels: updates state at a checkpoint, reads it back, and forks a run", async () => {
    running = await startEchoServer();
    const { baseUrl } = running;
    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
    type Values = { messages: Array<{ content: string }> };
    const lastContent = (v: Values) => v.messages.at(-1)?.content;

    const thread = (await (await post("/threads", {})).json()) as { thread_id: string };
    const tid = thread.thread_id;

    // Establish a checkpoint by running the graph once.
    const first = (await (
      await post(`/threads/${tid}/runs/wait`, {
        assistant_id: "echo",
        input: { messages: [{ role: "user", content: "hi" }] },
      })
    ).json()) as Values;
    expect(lastContent(first)).toBe("echo: hi");
    const firstLen = first.messages.length;

    const history = (await (await post(`/threads/${tid}/history`, {})).json()) as Array<{
      checkpoint: { checkpoint_id: string };
    }>;
    const tip = history[0]?.checkpoint.checkpoint_id;
    expect(typeof tip).toBe("string");

    // Update (fork) state — response is the new checkpoint pointer, matching LangGraph's wire shape.
    const updateRes = await post(`/threads/${tid}/state`, {
      values: { messages: [{ role: "user", content: "forked" }] },
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { checkpoint: { checkpoint_id: string } };
    expect(typeof updated.checkpoint.checkpoint_id).toBe("string");
    expect(updated.checkpoint.checkpoint_id).not.toBe(tip);

    // Read state at the pre-fork checkpoint — it still carries the original run's messages.
    const past = (await (await fetch(`${baseUrl}/threads/${tid}/state/${tip}`)).json()) as {
      values: Values;
    };
    expect(past.values.messages).toHaveLength(firstLen);
    expect(lastContent(past.values)).toBe("echo: hi");

    // The current tip reflects the fork (one extra message appended by the update).
    const now = (await (await fetch(`${baseUrl}/threads/${tid}/state`)).json()) as {
      values: Values;
    };
    expect(now.values.messages).toHaveLength(firstLen + 1);
    expect(lastContent(now.values)).toBe("forked");

    // A run can branch from a chosen checkpoint via a top-level checkpoint_id (not the client config).
    const forkedRun = (await (
      await post(`/threads/${tid}/runs/wait`, {
        assistant_id: "echo",
        input: { messages: [{ role: "user", content: "again" }] },
        checkpoint_id: tip,
      })
    ).json()) as Values;
    expect(lastContent(forkedRun)).toBe("echo: again");
  });

  it("streams SSE frames and a synthesized terminal `end` event", async () => {
    running = await startEchoServer();
    const { baseUrl } = running;

    const res = await fetch(`${baseUrl}/runs/stream`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        assistant_id: "echo",
        input: { messages: [{ role: "user", content: "hello" }] },
        stream_mode: "values",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    expect(body).toContain("event:");
    expect(body).toContain("echo: hello");
    expect(body).toContain("event: end");
  });

  it("survives a client that disconnects mid-stream", async () => {
    running = await startEchoServer();
    const { baseUrl } = running;

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/runs/stream`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        assistant_id: "echo",
        input: { messages: [{ role: "user", content: "hi" }] },
      }),
      signal: controller.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    if (!reader) throw new Error("expected a readable SSE body");
    await reader.read(); // first frame flushed
    await reader.cancel(); // hang up → server sees the response close
    controller.abort();

    // The adapter released the response without wedging the server: it still serves new requests.
    const ping = await fetch(`${baseUrl}/threads`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    expect(ping.status).toBe(200);
  });

  it("does not emit CORS headers by default (non-permissive)", async () => {
    running = await startEchoServer();
    const { baseUrl } = running;

    const res = await fetch(`${baseUrl}/threads`, {
      method: "POST",
      headers: { ...jsonHeaders, origin: "http://localhost:3000" },
      body: "{}",
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers CORS preflight and allows a configured origin", async () => {
    running = await startEchoServer({ cors: { origin: "http://localhost:3000" } });
    const { baseUrl } = running;

    const preflight = await fetch(`${baseUrl}/threads`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");

    const actual = await fetch(`${baseUrl}/threads`, {
      method: "POST",
      headers: { ...jsonHeaders, origin: "http://localhost:3000" },
      body: "{}",
    });
    expect(actual.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});
