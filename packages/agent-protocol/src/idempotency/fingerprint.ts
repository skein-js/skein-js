// How an `Idempotency-Key` request is identified: the scope it is filed under, and the fingerprint
// that proves a retry is really the same request.

import type { ProtocolRequest } from "../create-handlers.js";
import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";

/**
 * The bucket a key is filed under — `"{METHOD} {path} {principal}"`.
 *
 * **The principal is security-load-bearing, not bookkeeping.** Idempotency keys are chosen by
 * callers, and callers choose badly (`"1"`, a bare timestamp, the upstream provider's message id).
 * Without the principal in the scope, one tenant picking a key another tenant already used would be
 * handed that tenant's recorded response — which names a run id and a thread id they have no other
 * way to see. Scoping by method and path as well keeps a key reused across two endpoints from
 * colliding, which callers do more often than they admit.
 *
 * An unauthenticated deployment has no principal, and every caller shares one scope. That is the
 * correct reading of a server with no tenants: there is only one caller.
 */
export function idempotencyScope(req: ProtocolRequest, principalId?: string): string {
  return `${req.method.toUpperCase()} ${pathOf(req)} ${principalId ?? ""}`;
}

/**
 * A hex SHA-256 over the request's method, path, sorted query pairs, and body — what a replay is
 * checked against, so the same key sent with a *different* body is refused (422) rather than
 * silently answered with the first request's response.
 *
 * The **concrete path**, not the route template: the same body posted to two threads is genuinely
 * two requests, and `/threads/{id}/runs` would hash them the same. The body is taken as the wrapper
 * sees it — after an adapter has folded `thread_id` in — so the thread is covered twice and can
 * never be implicit.
 *
 * Hashed **before** Zod validation, deliberately: this wrapper is schema-agnostic, and teaching it
 * each route's schema to hash the parsed form would couple it to every create it wraps. Sorting
 * object keys in {@link canonicalJson} removes the only realistic false mismatch that raw hashing
 * would otherwise produce.
 */
export function requestFingerprint(req: ProtocolRequest): string {
  return sha256Hex(
    canonicalJson([
      req.method.toUpperCase(),
      pathOf(req),
      sortedQuery(req.query),
      req.body ?? null,
    ]),
  );
}

/**
 * The request's path, without scheme, host or query.
 *
 * `ProtocolRequest.url` is absolute, but an adapter builds it from whatever host header it was
 * given. Hashing the host would make the same request through two ingresses two different requests,
 * so only the path is taken — and a relative or malformed URL falls back to the raw string rather
 * than throwing on a request that was otherwise fine.
 */
function pathOf(req: ProtocolRequest): string {
  try {
    return new URL(req.url, "http://skein.invalid").pathname;
  } catch {
    return req.url;
  }
}

/**
 * Query parameters as sorted `[key, value]` pairs, so `?a=1&b=2` and `?b=2&a=1` agree.
 *
 * Included because a query flag can change what a create *does* — `POST /runs/wait` reads
 * `cancel_on_disconnect` — so two requests differing only there are not the same request. Repeated
 * parameters keep their own order within a key: an adapter that surfaces `?tag=a&tag=b` as an array
 * is reporting caller order, and reordering it would be the array mistake again.
 */
function sortedQuery(query: ProtocolRequest["query"]): [string, string | string[]][] {
  return Object.entries(query)
    .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
