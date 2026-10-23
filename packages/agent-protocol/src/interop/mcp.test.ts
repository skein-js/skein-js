import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createProtocolRuntime } from "../runtime.js";

describe("MCP protocol transport", () => {
  it("uses the official client for initialization, assistant discovery and execution", async () => {
    const runtime = createProtocolRuntime(createFixtureDeps());
    await runtime.service.assistants.registerGraphAssistants();
    const client = new Client({ name: "conformance", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === "POST" ? await request.json() : undefined;
        const response = await runtime.handlers.handleMcp!({
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body,
          params: {},
          query: {},
          signal: request.signal,
        });
        if (response.kind === "sse") throw new Error("Expected stateless JSON");
        return new Response(response.kind === "empty" ? null : JSON.stringify(response.body), {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("echo");
      const result = await client.callTool({ name: "echo", arguments: { value: "MCP" } });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ value: "echo: MCP" });
      expect(await runtime.service.threads.list()).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
