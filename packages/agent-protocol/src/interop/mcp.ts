import { internalProtocolHandlers } from "../meta/http-telemetry.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { serializeWireJson, SkeinHttpError, type Assistant } from "@skein-js/core";

import type { ProtocolHandler, ProtocolHandlers, ProtocolResponse } from "../create-handlers.js";

function jsonBody(response: ProtocolResponse): unknown {
  if (response.kind !== "json") throw new Error("Expected a JSON service response.");
  return response.body;
}

/** Stateless transport owned by the official SDK; each operation re-enters the authorized table. */
export function createMcpHandler(handlers: () => ProtocolHandlers): ProtocolHandler {
  return async (request) => {
    const server = new Server({ name: "skein-js", version: "1" }, { capabilities: { tools: {} } });
    const table = internalProtocolHandlers(handlers());
    server.setRequestHandler(ListToolsRequestSchema, async (command) => {
      const cursor = command.params?.cursor;
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw SkeinHttpError.badRequest("Invalid tools cursor.");
      const response = await table.searchAssistants({
        ...request,
        body: { limit: 100, offset },
        params: {},
      });
      const assistants = jsonBody(response) as Assistant[];
      const tools: Tool[] = await Promise.all(
        assistants.map(async (assistant) => {
          const schemas = jsonBody(
            await table.getAssistantSchemas({
              ...request,
              body: undefined,
              params: { assistant_id: assistant.assistant_id },
            }),
          ) as Record<string, unknown>;
          const graphSchemas = schemas[assistant.graph_id] as Record<string, unknown> | undefined;
          const input = (schemas["input_schema"] ?? graphSchemas?.["input_schema"]) as
            Tool["inputSchema"] | undefined;
          return {
            name: assistant.assistant_id,
            title: assistant.name,
            description: assistant.description ?? assistant.name,
            inputSchema: input ?? { type: "object", additionalProperties: true },
          };
        }),
      );
      return { tools, ...(assistants.length === 100 ? { nextCursor: String(offset + 100) } : {}) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (command, extra) => {
      const assistantId = command.params.name;
      // Read permission on the named assistant is checked even when the caller did not list tools.
      await table.getAssistant({
        ...request,
        body: undefined,
        params: { assistant_id: assistantId },
      });
      const response = await table.createWaitRun({
        ...request,
        params: {},
        signal: request.signal ? AbortSignal.any([request.signal, extra.signal]) : extra.signal,
        body: {
          assistant_id: assistantId,
          input: command.params.arguments ?? {},
          on_disconnect: "cancel",
        },
      });
      const output = jsonBody(response);
      return {
        content: [{ type: "text", text: serializeWireJson(output) }],
        ...(typeof output === "object" && output !== null
          ? { structuredContent: output as Record<string, unknown> }
          : {}),
        isError: typeof output === "object" && output !== null && "__error__" in output,
      };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (value !== undefined) headers.set(name, value);
      const native = new Request(request.url, {
        method: request.method,
        headers,
        signal: request.signal,
      });
      const response = await transport.handleRequest(native, { parsedBody: request.body });
      const responseHeaders = Object.fromEntries(response.headers);
      const body = await response.text();
      if (!body) return { kind: "empty", status: response.status, headers: responseHeaders };
      return {
        kind: "json",
        status: response.status,
        body: JSON.parse(body),
        headers: responseHeaders,
      };
    } finally {
      await server.close();
    }
  };
}
