import {
  createMcpHandler as createSdkMcpHandler,
  isLegacyRequest,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type Tool,
} from "@modelcontextprotocol/server";
import { SkeinHttpError, type Assistant } from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import type { ProtocolHandler, ProtocolHandlers } from "../create-handlers.js";
import { internalProtocolHandlers } from "../meta/http-telemetry.js";

import { callMcpTool, mcpJsonBody } from "./mcp-rounds.js";

/** Official transports own framing/version semantics; every operation re-enters authorization. */
export function createMcpHandler(
  context: ProtocolContext,
  handlers: () => ProtocolHandlers,
): ProtocolHandler {
  return async (request) => {
    const table = internalProtocolHandlers(handlers());
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined) headers.set(name, value);
    const native = new Request(request.url, {
      method: request.method,
      headers,
      signal: request.signal,
    });
    const legacy = await isLegacyRequest(native, request.body);
    const factory = () => {
      const server = new Server(
        { name: "skein-js", version: "1" },
        { capabilities: { tools: {} }, inputRequired: { legacyShim: false } },
      );
      server.setRequestHandler("tools/list", async (command) => {
        const cursor = command.params?.cursor;
        const offset = cursor === undefined ? 0 : Number(cursor);
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw SkeinHttpError.badRequest("Invalid tools cursor.");
        const assistants = mcpJsonBody<Assistant[]>(
          await table.searchAssistants({ ...request, body: { limit: 100, offset }, params: {} }),
        );
        const tools: Tool[] = await Promise.all(
          assistants.map(async (assistant) => {
            const schemas = mcpJsonBody<Record<string, unknown>>(
              await table.getAssistantSchemas({
                ...request,
                body: undefined,
                params: { assistant_id: assistant.assistant_id },
              }),
            );
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
        return {
          tools,
          ...(assistants.length === 100 ? { nextCursor: String(offset + 100) } : {}),
        };
      });
      server.setRequestHandler("tools/call", (command, extra) =>
        callMcpTool({
          context,
          table,
          request: {
            ...request,
            signal: request.signal
              ? AbortSignal.any([request.signal, extra.mcpReq.signal])
              : extra.mcpReq.signal,
          },
          assistantId: command.params.name,
          args: command.params.arguments ?? {},
          modern: !legacy,
          requestState: extra.mcpReq.requestState(),
          inputResponses: extra.mcpReq.inputResponses,
          runtimeContext: (request.body as { params?: Record<string, unknown> }).params?.[
            "context"
          ],
        }),
      );
      return server;
    };
    let response: Response;
    let close: () => Promise<void>;
    if (legacy) {
      // Keep the established JSON legacy exchange; SDK's default fallback otherwise chooses SSE.
      const server = factory();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      close = () => server.close();
      try {
        await server.connect(transport);
        response = await transport.handleRequest(native, { parsedBody: request.body });
      } catch (error) {
        await close();
        throw error;
      }
    } else {
      // No related notifications are emitted, so the SDK's auto mode produces a JSON exchange.
      const http = createSdkMcpHandler(factory, { legacy: "reject" });
      close = http.close;
      try {
        response = await http.fetch(native, { parsedBody: request.body });
      } catch (error) {
        await close();
        throw error;
      }
    }
    try {
      const body = await response.text();
      const responseHeaders = Object.fromEntries(response.headers);
      if (!body) return { kind: "empty", status: response.status, headers: responseHeaders };
      const output = JSON.parse(body) as { error?: { code?: number } };
      const status =
        !legacy && (output.error?.code === -32602 || output.error?.code === -32021)
          ? 400
          : response.status;
      return { kind: "json", status, body: output, headers: responseHeaders };
    } finally {
      await close();
    }
  };
}
