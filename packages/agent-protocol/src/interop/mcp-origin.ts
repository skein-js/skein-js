import type { Checkpoint, RunKwargs } from "@skein-js/core";

interface McpOrigin {
  roundState?: string;
  answerFingerprint?: string;
  expectedRunId?: string;
  checkpoint?: Checkpoint;
  interruptIds?: readonly string[];
}
const MCP_ORIGIN = Symbol("mcp-origin");

/** JSON callers cannot manufacture the adapter's continuation provenance. */
export function markMcpBody<T extends object>(body: T, origin: McpOrigin): T {
  return { ...body, [MCP_ORIGIN]: origin };
}

export function transferMcpOrigin<T extends object>(body: unknown, parsed: T): T {
  return typeof body === "object" && body !== null && MCP_ORIGIN in body
    ? { ...parsed, [MCP_ORIGIN]: body[MCP_ORIGIN] }
    : parsed;
}

export function mcpKwargs(input: object): { mcp_origin?: McpOrigin } {
  return MCP_ORIGIN in input ? { mcp_origin: input[MCP_ORIGIN] as McpOrigin } : {};
}

export function readMcpOrigin(kwargs: RunKwargs | null): McpOrigin | undefined {
  return kwargs && "mcp_origin" in kwargs ? (kwargs.mcp_origin as McpOrigin) : undefined;
}
