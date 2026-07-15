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
