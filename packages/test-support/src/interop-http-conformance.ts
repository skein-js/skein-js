import { SkeinHttpError, type AuthEngine } from "@skein-js/core";
import { expect, it } from "vitest";

/** Wire checks shared by each transport; official client semantics also run in the packed consumer. */
export function runInteropHttpConformance(
  name: string,
  start: (options?: {
    auth?: AuthEngine;
    disable?: { docs?: boolean; meta?: boolean; runs?: boolean };
  }) => Promise<{ baseUrl: string; close(): Promise<void> }>,
): void {
  for (const disabled of [
    {},
    { docs: true },
    { meta: true },
    { docs: true, meta: true },
  ] as const) {
    it(`${name} serves only enabled diagnostics (${JSON.stringify(disabled)})`, async () => {
      // Embedded adapters may leave the health endpoint to their host. Flags must not change it.
      const baseline = await start();
      let healthStatus: number;
      try {
        healthStatus = (await fetch(baseline.baseUrl + "/ok")).status;
      } finally {
        await baseline.close();
      }
      const server = await start({ disable: disabled });
      try {
        const hidden = Boolean("docs" in disabled || "meta" in disabled);
        expect((await fetch(server.baseUrl + "/docs")).status).toBe(hidden ? 404 : 200);
        expect((await fetch(server.baseUrl + "/openapi.json")).status).toBe(hidden ? 404 : 200);
        expect((await fetch(server.baseUrl + "/info")).status).toBe("meta" in disabled ? 404 : 200);
        expect((await fetch(server.baseUrl + "/metrics")).status).toBe(
          "meta" in disabled ? 404 : 501,
        );
        expect((await fetch(server.baseUrl + "/ok")).status).toBe(healthStatus);
      } finally {
        await server.close();
      }
    });
  }

  it(`${name} searches completed runs through the shared HTTP contract`, async () => {
    const server = await start();
    const post = (path: string, body: unknown) =>
      fetch(server.baseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const thread = (await (await post("/threads", {})).json()) as { thread_id: string };
      expect(
        (
          await post("/threads/" + thread.thread_id + "/runs/wait", {
            assistant_id: "echo",
            input: { messages: [{ role: "user", content: "search" }] },
          })
        ).status,
      ).toBe(200);
      const response = await post("/runs/search", {
        status: "success",
        assistant_id: "echo",
        thread_id: thread.thread_id,
        limit: 1,
      });
      expect(response.status).toBe(200);
      const runs = (await response.json()) as Record<string, unknown>[];
      expect(runs).toMatchObject([
        { thread_id: thread.thread_id, assistant_id: "echo", status: "success" },
      ]);
      expect(runs[0]).not.toHaveProperty("kwargs");
      expect(runs[0]).not.toHaveProperty("result");
      const spec = (await (await fetch(server.baseUrl + "/openapi.json")).json()) as {
        paths: Record<string, unknown>;
      };
      expect(spec.paths["/runs/search"]).toMatchObject({
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  properties: expect.objectContaining({ updated_after: expect.anything() }),
                },
              },
            },
          },
        },
      });
      expect((await post("/runs/search", { status: "failed" })).status).toBe(400);
    } finally {
      await server.close();
    }
    const disabled = await start({ disable: { runs: true } });
    try {
      expect(
        (
          await fetch(disabled.baseUrl + "/runs/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(404);
      const spec = (await (await fetch(disabled.baseUrl + "/openapi.json")).json()) as {
        paths: Record<string, unknown>;
      };
      expect(spec.paths).not.toHaveProperty("/runs/search");
    } finally {
      await disabled.close();
    }
  });

  it(`${name} authenticates discovery and interop routes before dispatch`, async () => {
    const auth: AuthEngine = {
      enabled: true,
      studioAuthDisabled: true,
      authenticate: async () => {
        throw SkeinHttpError.unauthorized("A token is required.");
      },
      authorize: async (input) => ({ value: input.value }),
      matchesFilters: () => true,
    };
    const server = await start({ auth });
    try {
      for (const route of ["/openapi.json", "/docs", "/metrics"])
        expect((await fetch(server.baseUrl + route)).status).toBe(401);
      for (const route of ["/mcp", "/a2a/echo"])
        expect(
          (
            await fetch(server.baseUrl + route, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
            })
          ).status,
        ).toBe(401);
    } finally {
      await server.close();
    }
  });
  it(`${name} serves discovery, MCP tools, and A2A tasks over HTTP`, async () => {
    const server = await start();
    const post = (path: string, body: unknown) =>
      fetch(server.baseUrl + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    try {
      const spec = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
      expect(spec).toMatchObject({
        paths: { "/mcp": expect.any(Object), "/a2a/{assistant_id}": expect.any(Object) },
      });
      const initialized = await post("/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "adapter-proof", version: "1.0.0" },
        },
      });
      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toMatchObject({
        id: 1,
        result: { capabilities: { tools: expect.any(Object) } },
      });
      expect(
        await (
          await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
        ).json(),
      ).toMatchObject({
        result: { tools: expect.arrayContaining([expect.objectContaining({ name: "echo" })]) },
      });
      expect(
        await (
          await post("/mcp", {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "echo", arguments: { messages: [{ role: "user", content: "MCP" }] } },
          })
        ).json(),
      ).toMatchObject({ result: { isError: false } });
      const card = await (
        await fetch(`${server.baseUrl}/.well-known/agent-card.json?assistant_id=echo`)
      ).json();
      expect(card).toMatchObject({ capabilities: { streaming: true } });
      const params = {
        message: { messageId: "adapter", role: "ROLE_USER", parts: [{ text: "A2A" }] },
      };
      expect(
        await (
          await post("/a2a/echo", { jsonrpc: "2.0", id: 4, method: "SendMessage", params })
        ).json(),
      ).toMatchObject({ result: { task: { status: { state: "TASK_STATE_COMPLETED" } } } });
      const streamed = await post("/a2a/echo", {
        jsonrpc: "2.0",
        id: 5,
        method: "SendStreamingMessage",
        params,
      });
      expect(streamed.headers.get("content-type")).toContain("text/event-stream");
      expect(await streamed.text()).toContain("TASK_STATE_COMPLETED");
      expect(
        await (
          await post("/a2a/echo", { jsonrpc: "2.0", id: 6, method: "unsupported", params: {} })
        ).json(),
      ).toMatchObject({ error: { code: -32601 } });
    } finally {
      await server.close();
    }
  }, 15_000);
}
