// The deepest link of an `Error.cause` chain — the thing that actually went wrong.
//
// skein wraps as it layers: `@skein-js/config` throws `SkeinConfigError: Failed to import graph
// module "…/agent-graph.ts"` whose `cause` is the graph's real failure ("GOOGLE_API_KEY is not
// set"). The wrapper says *where*; only the root says *what*. Every surface that reports a failure
// in one line — an HTTP message, a CLI block's headline — wants the root, and every one of them was
// otherwise reaching for `error.message` and printing the wrapper.
//
// Distinct from `toRunError`, which preserves the whole chain because a client rendering a failed
// run should see every layer. This collapses it, for the places that have room for exactly one
// sentence.

/** How deep the `cause` chain is walked before it is truncated. Matches `toRunError`. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Read a property that might be defined by a throwing getter. Like `toRunError`, this runs on the
 * failure path, where a second failure would hide the first.
 */
function readProperty(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The deepest value in `thrown`'s `cause` chain — `thrown` itself when it has no `cause`.
 *
 * Depth-capped and cycle-safe: a chain that loops back on itself stops at the repeat rather than
 * spinning, and either cap returns the deepest link reached, never `undefined`.
 *
 * @example
 * ```ts
 * const wrapped = new Error("Failed to import graph module.", { cause: new Error("no API key") });
 * rootCause(wrapped); // → Error: no API key
 * ```
 */
export function rootCause(thrown: unknown): unknown {
  const seen = new WeakSet<object>();
  let current = thrown;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return current;
    if (seen.has(current)) return current;
    seen.add(current);
    const cause = readProperty(current, "cause");
    if (cause === undefined || cause === null) return current;
    current = cause;
  }
  return current;
}

/**
 * The message of {@link rootCause} — what to put in a one-line report.
 *
 * Falls back to `String(value)` for a non-`Error` throw and to the error's `name` for one with an
 * empty message, so the result is never blank. Never throws.
 */
export function rootCauseMessage(thrown: unknown): string {
  const root = rootCause(thrown);
  if (!(root instanceof Error)) {
    try {
      return String(root);
    } catch {
      return Object.prototype.toString.call(root);
    }
  }
  const message = readProperty(root, "message");
  if (typeof message === "string" && message.length > 0) return message;
  const name = readProperty(root, "name");
  return typeof name === "string" && name.length > 0 ? name : "Error";
}
