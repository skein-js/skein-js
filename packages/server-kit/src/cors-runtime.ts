// Runtime CORS helpers shared by the framework adapters that don't use a CORS middleware of their own
// (NestJS via its middleware, Next.js via its route handlers). Express/Fastify use `cors`/`@fastify/cors`
// directly; these helpers derive the same headers from the shared `CorsOptions` shape. Origin matching
// mirrors `cors-config.ts` (full-string-anchored regex), and — critically — an *unset* origin resolves
// to `*` (never a reflected origin), so `{ credentials: true }` without an explicit origin stays inert
// in the browser instead of silently allowing any origin credentialed access.

import type { ServerResponse } from "node:http";

import type { CorsOptions } from "cors";

// `true` (reflect the request origin — permissive dev) or an explicit `CorsOptions`. `false`/`undefined`
// mean "no CORS" and are filtered out by the caller's `if (cors)` guard before these helpers run.
export type CorsSetting = true | CorsOptions;

/**
 * Resolve the `Access-Control-Allow-Origin` value for a request origin, or `undefined` to deny.
 * An unset `origin` resolves to `*` (matching the `cors`/`@fastify/cors` default) rather than
 * reflecting the caller's origin, so it can never be paired with credentials into a wildcard bypass.
 */
export function allowedOrigin(
  requestOrigin: string | undefined,
  cors: CorsSetting,
): string | undefined {
  const origin = cors === true ? true : cors.origin;
  // Explicit reflect (the `origin: true` / `cors: true` dev shorthand). The boolean `cors` form never
  // carries credentials (see `corsResponseHeaders`), so this can't become a credentialed wildcard.
  if (origin === true) return requestOrigin ?? "*";
  // Unset (or `"*"`) → allow-all `*`. Deliberately NOT a reflected origin: `*` is rejected by browsers
  // when combined with credentials, so a `{ credentials: true }` misconfig fails safe (as on Express).
  if (origin === undefined || origin === "*") return "*";
  if (typeof origin === "string") return origin;
  if (Array.isArray(origin)) {
    return requestOrigin && origin.includes(requestOrigin) ? requestOrigin : undefined;
  }
  if (origin instanceof RegExp) {
    // Full-string match (anchored), mirroring cors-config so `trusted\.com` can't substring-match
    // `trusted.com.attacker.io`. Strip `g` to avoid `lastIndex` statefulness across requests.
    const anchored = new RegExp(`^(?:${origin.source})$`, origin.flags.replace("g", ""));
    return requestOrigin && anchored.test(requestOrigin) ? requestOrigin : undefined;
  }
  if (typeof origin === "function") {
    // `cors`-package style: `origin(requestOrigin, (err, allow) => …)`. The function form produced by
    // cors-config (from `allow_origin_regex`) calls back synchronously; capture its verdict.
    let verdict: unknown;
    (origin as (o: string | undefined, cb: (err: Error | null, allow?: unknown) => void) => void)(
      requestOrigin,
      (_err, allow) => {
        verdict = allow;
      },
    );
    if (verdict === true) return requestOrigin ?? "*";
    if (typeof verdict === "string") return verdict;
    return undefined;
  }
  return undefined;
}

/** Join a `string | string[]` option into a comma list, or `undefined` when absent. */
export function joinList(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return ([] as string[]).concat(value).join(",");
}

/** The CORS response headers to merge onto an actual (non-preflight) response. */
export function corsResponseHeaders(
  requestOrigin: string | undefined,
  cors: CorsSetting,
): Record<string, string> {
  const allow = allowedOrigin(requestOrigin, cors);
  if (allow === undefined) return {};
  const headers: Record<string, string> = { "access-control-allow-origin": allow };
  if (allow !== "*") headers["vary"] = "origin";
  if (cors !== true && cors.credentials) headers["access-control-allow-credentials"] = "true";
  const exposed = cors !== true ? joinList(cors.exposedHeaders) : undefined;
  if (exposed) headers["access-control-expose-headers"] = exposed;
  return headers;
}

/** The preflight response headers for an `OPTIONS` request. */
export function corsPreflightHeaders(
  requestOrigin: string | undefined,
  requestedHeaders: string | undefined,
  cors: CorsSetting,
): Record<string, string> {
  const headers = corsResponseHeaders(requestOrigin, cors);
  headers["access-control-allow-methods"] =
    (cors !== true ? joinList(cors.methods) : undefined) ?? "GET,POST,PUT,PATCH,DELETE,OPTIONS";
  const allowedHeaders =
    (cors !== true ? joinList(cors.allowedHeaders) : undefined) ?? requestedHeaders;
  if (allowedHeaders) headers["access-control-allow-headers"] = allowedHeaders;
  if (cors !== true && typeof cors.maxAge === "number") {
    headers["access-control-max-age"] = String(cors.maxAge);
  }
  return headers;
}

/** First value of a possibly array-valued Node header. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Set CORS headers on a Node response for an actual request (before the status line is written). */
export function applyNodeCors(
  reqHeaders: { origin?: string | string[]; [key: string]: string | string[] | undefined },
  res: ServerResponse,
  cors: CorsSetting,
): void {
  const headers = corsResponseHeaders(firstHeader(reqHeaders.origin), cors);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}

/** Answer an `OPTIONS` preflight on a Node response with a 204 + CORS headers. */
export function sendNodePreflight(
  reqHeaders: {
    origin?: string | string[];
    "access-control-request-headers"?: string | string[];
    [key: string]: string | string[] | undefined;
  },
  res: ServerResponse,
  cors: CorsSetting,
): void {
  const headers = corsPreflightHeaders(
    firstHeader(reqHeaders.origin),
    firstHeader(reqHeaders["access-control-request-headers"]),
    cors,
  );
  res.writeHead(204, headers).end();
}
