// CORS for the Web (App Router) layer: thin adapters over server-kit's framework-neutral CORS helpers
// (origin resolution, response/preflight headers) that read from / write to Web `Request`/`Response`.
// Off by default (same-origin Next apps need nothing).

import { corsPreflightHeaders, corsResponseHeaders, type CorsSetting } from "@skein-js/server-kit";

/** The CORS response headers to merge onto every actual (non-preflight) response. */
export function corsHeaders(request: Request, cors: CorsSetting): Record<string, string> {
  return corsResponseHeaders(request.headers.get("origin") ?? undefined, cors);
}

/** The 204 preflight response for an `OPTIONS` request. */
export function preflightResponse(request: Request, cors: CorsSetting): Response {
  const headers = corsPreflightHeaders(
    request.headers.get("origin") ?? undefined,
    request.headers.get("access-control-request-headers") ?? undefined,
    cors,
  );
  return new Response(null, { status: 204, headers });
}
