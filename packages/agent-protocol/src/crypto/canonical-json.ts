// Deterministic JSON, so two serializations of the same request hash identically.
//
// Lives here rather than in `@skein-js/core` for the same reason `hash.ts` does: core has a hard
// zero-runtime-dependency invariant and is imported by every adapter, while this is only reached on
// a request that actually carries an `Idempotency-Key`.

/**
 * `JSON.stringify` with object keys sorted, recursively.
 *
 * **Arrays keep their order** — order is meaning in an array (a message list, a namespace path), and
 * sorting one would make two genuinely different requests hash the same. Only *object* key order is
 * insignificant, and it is the one thing that varies between clients serializing the same body.
 *
 * Without this, a caller whose HTTP client happens to emit `{"input":…,"assistant_id":…}` on the
 * retry it emitted as `{"assistant_id":…,"input":…}` the first time gets a 422 fingerprint mismatch
 * for a request that is byte-for-byte equivalent — a failure that looks like a skein bug and is
 * impossible to reproduce on demand.
 *
 * `undefined`, functions and symbols follow `JSON.stringify`'s own rules (dropped in objects, `null`
 * in arrays); a body that reached here came through JSON parsing, so it has none of them.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  // `Date` and friends have no place in a parsed request body, but a caller could hand us one
  // through the in-code seam; letting it through `Object.entries` would flatten it to `{}`, so
  // anything with a non-plain prototype is passed to `JSON.stringify` untouched.
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return value;
  // A null-prototype accumulator, not `{}`. Assigning `sorted["__proto__"]` on a plain object hits
  // `Object.prototype`'s setter instead of creating an own property, so the key silently vanishes
  // from the output — and two requests differing only in a `__proto__` field would hash identically.
  // (It is not prototype pollution: only this local object's prototype would move. It is a
  // fingerprint collision, which for an idempotency key is its own problem.)
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
