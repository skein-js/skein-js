// Render any thrown value as plain text: its stack, any structured `details` it carries, and its
// whole `cause` chain. Plain text only — coloring is the caller's business — so this serves every
// logging surface alike: the framework logger bridges (Nest, Fastify), `createConsoleLogger`, the
// CLI's colored dev logger, and the CLI's pre-banner console paths (`skein start`, the docker
// commands) that have no logger at all.
//
// This exists because every one of those paths used to print `String(error)` or `error.message`,
// which drops exactly the part that explains the failure: a `SkeinConfigError`'s `cause` is the real
// import error, and its `details` are the Zod issues.

/** How deep the `cause` chain is followed. Matches `toRunError` in @skein-js/core. */
const MAX_CAUSE_DEPTH = 5;

/** Read a property that might be defined by a throwing getter. */
function readProperty(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** `JSON.stringify` that never throws, for `details` of unknown shape. */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function describe(thrown: unknown, depth: number, seen: WeakSet<object>): string {
  if (!(thrown instanceof Error)) {
    return typeof thrown === "object" && thrown !== null
      ? (safeStringify(thrown) ?? String(thrown))
      : String(thrown);
  }

  const stack = readProperty(thrown, "stack");
  let described = typeof stack === "string" ? stack : `${thrown.name}: ${thrown.message}`;

  // Structural, so this covers SkeinConfigError and SkeinHttpError without importing either — and
  // keeps working if a duplicated install makes `instanceof` lie.
  const details = readProperty(thrown, "details");
  if (details !== undefined) {
    const rendered = safeStringify(details);
    if (rendered !== undefined) described += `\ndetails: ${rendered}`;
  }

  if (depth >= MAX_CAUSE_DEPTH || seen.has(thrown)) return described;
  seen.add(thrown);

  const cause = readProperty(thrown, "cause");
  if (cause === undefined) return described;
  return `${described}\ncaused by: ${describe(cause, depth + 1, seen)}`;
}

/**
 * An error's stack (falling back to `name: message`), its `details` when it carries any, and its
 * `cause` chain appended. Depth-capped and cycle-safe; never throws.
 */
export function describeError(thrown: unknown): string {
  return describe(thrown, 0, new WeakSet());
}
