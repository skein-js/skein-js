// Translating an `@auth.on.*` handler's ownership filters into a metadata subset the *driver* can match,
// so the query returns only the caller's own rows instead of every row for a JS filter to sift.
//
// This has to mirror `isAuthMatching` (`@langchain/langgraph-api`, which `AuthEngine.matchesFilters`
// delegates to) rather than approximate it. The safe direction is **broader**: the scoped store still
// runs `matchesFilters` over what comes back, so a clause that is too permissive costs a few extra rows,
// while one that is too strict silently hides rows the caller owns. Where the two cannot be made to
// agree, emit nothing and let the JS filter do the work.

import type { AuthFilters, Metadata } from "@skein-js/core";

/**
 * The ownership filters as a metadata subset, or `undefined` when they impose nothing a driver can
 * match. Feed the result to `ThreadSearchQuery.enforcedMetadata`.
 *
 * Both driver implementations match with jsonb containment semantics (`metadata @> …` in Postgres,
 * `isMetadataSubset` in memory), which lines up with `isAuthMatching`'s two cases:
 *
 * - a plain value, or `$eq` — containment of a scalar is equality, matching `metadata[key] !== value`;
 * - `$contains` — a **wrapped array** (`{ tags: ["a"] }`), because array containment requires the stored
 *   value to be an array holding every wanted element, which is exactly `$contains`'s check.
 */
export function authFiltersToMetadataSubset(filters?: AuthFilters): Metadata | undefined {
  if (!filters) return undefined;

  const subset: Record<string, unknown> = {};
  for (const [key, clause] of Object.entries(filters)) {
    if (typeof clause !== "object" || clause === null) {
      // `undefined` is the one plain value that must be skipped, and it is off-type but reachable — an
      // auth handler returning `{ owner: user.org_id }` for a user with no org produces it. The engine
      // reads it as no constraint (`metadata[key] !== undefined` is false when the key is absent), and
      // the two drivers would disagree about it in *opposite* directions: `isMetadataSubset` requires the
      // key to be present and undefined, so it matches nothing, while `JSON.stringify` drops the key
      // entirely, so `metadata @> '{}'` matches everything.
      if (clause === undefined) continue;
      // Any other plain value always constrains — including `""`, which `isAuthMatching` compares
      // with `!==`.
      subset[key] = clause;
      continue;
    }
    // `isAuthMatching` tests `$eq`/`$contains` for *truthiness*, so `{ $eq: "" }` and `{}` impose no
    // constraint at all there. Turning either into a clause here would hide rows the engine considers
    // visible, so they are skipped for the same reason.
    if (clause.$eq) {
      subset[key] = clause.$eq;
    } else if (clause.$contains) {
      subset[key] = Array.isArray(clause.$contains) ? clause.$contains : [clause.$contains];
    }
  }

  return Object.keys(subset).length > 0 ? (subset as Metadata) : undefined;
}
