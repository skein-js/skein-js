import { MemorySaver } from "@langchain/langgraph";
import type { ThreadStorage } from "@skein-js/core";
import { inspectMemoryThreadStorage } from "@skein-js/langgraph";
import { expect, it } from "vitest";

import { createEchoDeps, startEchoServer } from "./__fixtures__/echo-server.js";

it("serves discovery for enabled routes, offline docs, exact saver payload sizes and host metrics", async () => {
  const deps = createEchoDeps();
  const saver = new MemorySaver();
  deps.checkpointer = saver;
  deps.inspectThreadStorage = (threadId) => inspectMemoryThreadStorage(saver, threadId);
  const requests: string[] = [];
  deps.telemetry = {
    name: "host",
    onHttpEvent: (event) => {
      requests.push(event.route);
    },
    collectMetrics: async (format) => ({
      body: format === "json" ? '{"host":true}' : "host_counter 1\n",
      contentType: format === "json" ? "application/json" : "text/plain",
    }),
  };
  const running = await startEchoServer({ deps, disable: { crons: true } });
  try {
    const spec = (await (await fetch(`${running.baseUrl}/openapi.json`)).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      "x-skein-authentication": { enabled: boolean };
    };
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.paths["/threads/{thread_id}/stream/events"]).toMatchObject({
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { properties: { channels: expect.any(Object) } } },
          },
        },
      },
    });
    expect(spec.paths["/threads/{thread_id}/runs"]).toMatchObject({
      post: { requestBody: { required: true } },
    });
    expect(spec.paths["/threads/search"]).toMatchObject({
      post: { requestBody: { required: false } },
    });
    expect(Object.keys(spec.paths).some((path) => path.includes("crons"))).toBe(false);
    expect(spec.paths["/threads/{thread_id}/storage"]).toBeDefined();
    expect(spec["x-skein-authentication"].enabled).toBe(false);
    expect(await (await fetch(`${running.baseUrl}/docs`)).text()).toContain(
      "Skein Agent Server API",
    );
    expect(await (await fetch(`${running.baseUrl}/metrics`)).text()).toBe("host_counter 1\n");
    expect(await (await fetch(`${running.baseUrl}/metrics?format=json`)).json()).toEqual({
      host: true,
    });
    expect((await fetch(`${running.baseUrl}/metrics?format=unknown`)).status).toBe(400);
    const thread = await running.server.runtime.service.threads.create();
    const empty = (await (
      await fetch(`${running.baseUrl}/threads/${thread.thread_id}/storage`)
    ).json()) as ThreadStorage;
    expect(empty.total_bytes).toBe(0);
    await running.server.runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { messages: [{ role: "user", content: "saved" }] },
    });
    const stored = (await (
      await fetch(`${running.baseUrl}/threads/${thread.thread_id}/storage`)
    ).json()) as ThreadStorage;
    expect(stored).toEqual(inspectMemoryThreadStorage(saver, thread.thread_id));
    expect(stored.total_bytes).toBeGreaterThan(0);
    expect(requests.filter((name) => name === "getThreadStorage")).toHaveLength(2);
  } finally {
    await running.close();
  }
});

it("returns explicit unavailable errors for custom savers and missing metric collectors", async () => {
  const running = await startEchoServer();
  try {
    const thread = await running.server.runtime.service.threads.create();
    expect((await fetch(`${running.baseUrl}/threads/${thread.thread_id}/storage`)).status).toBe(
      501,
    );
    expect((await fetch(`${running.baseUrl}/metrics`)).status).toBe(501);
  } finally {
    await running.close();
  }
});
