// Map a Fastify request onto the core's transport-neutral `ProtocolRequest`. Pure shape translation —
// no protocol logic. Fastify already lowercases header names (matching how the handlers look up
// `last-event-id`); we only flatten the rare array-valued header to a single value.

import type { IncomingHttpHeaders } from "node:http";

import type { ProtocolRequest } from "@skein-js/agent-protocol";
import type { FastifyRequest } from "fastify";

/** Flatten `IncomingHttpHeaders` (some values are `string[]`) to the single-value map handlers read. */
function toSingleValueHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const flattened: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    flattened[name] = Array.isArray(value) ? value[0] : value;
  }
  return flattened;
}

/** Translate a Fastify `FastifyRequest` into the normalized `ProtocolRequest` the handler table reads. */
export function toProtocolRequest(req: FastifyRequest): ProtocolRequest {
  return {
    method: req.method,
    // Absolute URL so a synthesized WHATWG `Request` carries the path + query string; an auth
    // handler may read either. `req.url` is the original path + query.
    url: `${req.protocol}://${req.headers.host ?? "localhost"}${req.url}`,
    // Fastify types params/query as generics; the protocol's routes use single named params only and
    // the handlers read flat string / string[] query values, so these narrower shapes hold.
    params: (req.params ?? {}) as Record<string, string>,
    query: (req.query ?? {}) as ProtocolRequest["query"],
    body: req.body,
    headers: toSingleValueHeaders(req.headers),
  };
}
