// Map a Node HTTP request (as NestJS's default Express platform provides it) onto the core's
// transport-neutral `ProtocolRequest`. Pure shape translation — no protocol logic. We read only
// Node-level fields plus the body NestJS's body parser attaches, so the adapter does not depend on
// Express types. The caller supplies the parsed URL and matched path params.

import type { IncomingHttpHeaders } from "node:http";

import type { ProtocolRequest } from "@skein-js/agent-protocol";

/** The subset of a Node/Express request the adapter reads (structural, so no framework type needed). */
export interface NodeProtocolRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: IncomingHttpHeaders;
  /** Parsed JSON body, attached by NestJS's global body parser before middleware runs. */
  body?: unknown;
}

/** Flatten `IncomingHttpHeaders` (some values are `string[]`) to the single-value map handlers read. */
function toSingleValueHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const flattened: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    flattened[name] = Array.isArray(value) ? value[0] : value;
  }
  return flattened;
}

/** Query params from a parsed URL, keeping repeated keys as `string[]` (matching qs-style parsing). */
function toQuery(url: URL): ProtocolRequest["query"] {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] as string);
  }
  return query;
}

/** Translate a Node request (+ parsed URL, matched params, and already-parsed body) into a `ProtocolRequest`. */
export function toProtocolRequest(
  req: NodeProtocolRequest,
  url: URL,
  params: Record<string, string>,
  body: unknown,
): ProtocolRequest {
  return {
    method: req.method ?? "GET",
    url: url.href,
    params,
    query: toQuery(url),
    body,
    headers: toSingleValueHeaders(req.headers),
  };
}
