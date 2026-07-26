// The JSON-safe description of *why* a run failed. One shape serves three surfaces — the `error`
// SSE frame, the persisted `Run.error`, and the `__error__` body of a failed `POST /runs/wait` — so
// a client can never see the stream and the run row disagree about what went wrong.
//
// The field names are LangGraph Platform's, not ours. `@langchain/langgraph-api` serializes a run
// failure as `{ error, message }` (`error` holding `Error.name`), and the SDK's `ErrorStreamEvent`
// declares exactly that pair. We add `name` as an always-present alias of `error` because the SDK's
// `StreamError` reads `data.name ?? data.error` and skein's earlier frame carried `name` — emitting
// both keeps old skein clients working and matches the platform, with no ambiguity (same value).
// `cause`/`errors`/`stack` are additive: the SDK ignores keys it doesn't know.

/** How deep the `cause` chain is walked before it is truncated. */
const MAX_CAUSE_DEPTH = 5;

/** How many members of an `AggregateError` are kept. A fan-out graph can fail hundreds of tasks. */
const MAX_AGGREGATED_ERRORS = 10;

/** A JSON-safe description of a failure, published on the wire and persisted on the run row. */
export interface RunError {
  /** The error's constructor name (`Error.name`). LangGraph Platform's name for this field. */
  error: string;
  /** The error's message. The only field every client is guaranteed to render. */
  message: string;
  /**
   * Alias of {@link error}, always present and always identical. The SDK's `StreamError` prefers
   * `name`, and skein's frame carried `name` before it carried `error`; emitting both satisfies
   * every consumer at once.
   */
  name: string;
  /** The `Error.cause` chain, one level per link. Truncated past five levels. */
  cause?: RunError;
  /**
   * An `AggregateError`'s members, capped at ten. LangGraph throws one when several nodes fail in
   * the same superstep, and its envelope message ("Multiple errors occurred…") says nothing useful
   * on its own.
   */
  errors?: RunError[];
  /**
   * The server-side stack. Present only when the server opts in via `exposeErrorStacks` — a stack
   * names server paths and dependency versions, which a production caller has no business seeing.
   */
  stack?: string;
}

export interface ToRunErrorOptions {
  /** Include {@link RunError.stack} at every level of the chain. Off by default. */
  includeStack?: boolean;
}

/**
 * Read a property that might be defined by a throwing getter. A `RunError` is built on the failure
 * path, so anything that throws here would replace the user's real error with our own.
 */
function readProperty(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function convert(
  thrown: unknown,
  includeStack: boolean,
  depth: number,
  seen: WeakSet<object>,
): RunError {
  if (!(thrown instanceof Error)) {
    // A non-Error throw. The platform JSON-stringifies every such value, which turns `throw "boom"`
    // into the quoted `"boom"`; plain `String` turns `throw { code: 1 }` into `[object Object]`.
    // Take whichever is legible for the value at hand: JSON for objects, `String` for primitives.
    const message = typeof thrown === "object" && thrown !== null ? safeStringify(thrown) : "";
    return { error: "Error", name: "Error", message: message || String(thrown) };
  }

  const name = typeof thrown.name === "string" ? thrown.name : "Error";
  const message = typeof thrown.message === "string" ? thrown.message : "";
  const result: RunError = { error: name, name, message };

  if (includeStack) {
    const stack = readProperty(thrown, "stack");
    if (typeof stack === "string") result.stack = stack;
  }

  // Past the depth cap, or on a chain that loops back on itself, stop descending but keep this
  // level — a truncated chain is still far more useful than none.
  if (depth >= MAX_CAUSE_DEPTH) return result;
  if (seen.has(thrown)) return result;
  seen.add(thrown);

  const cause = readProperty(thrown, "cause");
  if (cause !== undefined) {
    result.cause = convert(cause, includeStack, depth + 1, seen);
  }

  const aggregated = readProperty(thrown, "errors");
  if (Array.isArray(aggregated) && aggregated.length > 0) {
    result.errors = aggregated
      .slice(0, MAX_AGGREGATED_ERRORS)
      .map((member) => convert(member, includeStack, depth + 1, seen));
  }

  return result;
}

/** `JSON.stringify` that never throws (a cyclic or BigInt-bearing object would). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Describe anything that was thrown as a {@link RunError}, walking the `cause` chain and any
 * `AggregateError` members. Never throws: it is called on the failure path, where a second failure
 * would hide the first. Depth and breadth are capped, and a cyclic `cause` chain terminates.
 */
export function toRunError(thrown: unknown, options: ToRunErrorOptions = {}): RunError {
  return convert(thrown, options.includeStack === true, 0, new WeakSet());
}

/**
 * Build a {@link RunError} for a failure skein raises itself, where there is no thrown `Error` to
 * describe — a run that exceeded its timeout, say. Use this rather than an object literal: `error`
 * and `name` must always agree, and writing them out by hand is the one way they could drift.
 */
export function runError(name: string, message: string): RunError {
  return { error: name, name, message };
}
