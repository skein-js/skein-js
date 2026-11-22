// Map an Express request onto the core's transport-neutral `ProtocolRequest`. This is pure shape
// translation — no protocol logic. Express already lowercases header names (matching how the
// handlers look up `last-event-id`); we only flatten the rare array-valued header to a single value.

import type { IncomingHttpHeaders } from "node:http";

import type { ProtocolRequest } from "@skein-js/agent-protocol";
import type { Request } from "express";

/** Flatten `IncomingHttpHeaders` (some values are `string[]`) to the single-value map handlers read. */
function toSingleValueHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const flattened: Record<string, string | undefined> = {};

  for (const [name, value] of Object.entries(headers)) {
    flattened[name] = Array.isArray(value) ? value[0] : value;
  }

  return flattened;
}

/** Translate an Express `Request` into the normalized `ProtocolRequest` the handler table consumes. */
export function toProtocolRequest(req: Request): ProtocolRequest {
  return {
    method: req.method,
    // Absolute URL so a synthesized WHATWG `Request` carries the path + query string; an auth
    // handler may read either. `req.originalUrl` includes the query, unlike `req.path`.
    url: `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`,
    // Express 5 types params as `string | string[]`, but the protocol's routes use single named
    // params only, so the narrower `Record<string, string>` holds.
    params: req.params as Record<string, string>,
    // Express parses the query string with `qs`; the handlers only read flat string / string[]
    // values, so the parsed shape is compatible.
    query: req.query as ProtocolRequest["query"],
    body: req.body,
    headers: toSingleValueHeaders(req.headers),
  };
}
