// Translate a stored `RunKwargs` into the two things LangGraph needs: the graph *input* (a value,
// or a `Command` when resuming) and the *call options* (thread-scoped config, stream modes, abort
// signal). Kept separate from the engine so the mapping is easy to test on its own.

import { Command, type CommandParams } from "@langchain/langgraph";
import type { AuthUser, RunKwargs, StreamMode } from "@skein-js/core";

/** SDK stream modes mapped to the graph's stream vocabulary. */
function toGraphMode(mode: StreamMode): StreamMode {
  // `messages-tuple` is the SDK's token-streaming alias for the graph's `messages` mode.
  if (mode === "messages-tuple") return "messages";
  return mode;
}

/**
 * Normalize requested modes to a non-empty, de-duplicated array. `events` is preserved (not
 * downgraded): the engine drives it via `graph.streamEvents` and strips it from the graph
 * `streamMode` via {@link toGraphStreamModes}.
 */
export function normalizeModes(mode?: StreamMode | StreamMode[]): StreamMode[] {
  const requested = mode === undefined ? [] : Array.isArray(mode) ? mode : [mode];
  const mapped = requested.map(toGraphMode);
  const deduped = [...new Set(mapped)];
  return deduped.length > 0 ? deduped : ["values"];
}

/** True when the caller asked for the token-level `events` stream mode. */
export function wantsEventsMode(mode?: StreamMode | StreamMode[]): boolean {
  return normalizeModes(mode).includes("events");
}

/**
 * The graph-valid stream modes for `graph.stream`/`graph.streamEvents`' `streamMode` option —
 * `events` removed (it is not a Pregel stream mode; it comes from the event stream itself). May be
 * empty when only `events` was requested, which is valid for the `streamEvents` path.
 */
export function toGraphStreamModes(mode?: StreamMode | StreamMode[]): StreamMode[] {
  return normalizeModes(mode).filter((m) => m !== "events");
}

/** The graph input for this run: a `Command` when resuming/commanding, else the raw input (or null). */
export function toGraphInput(kwargs: RunKwargs): unknown {
  if (kwargs.command) {
    // The protocol's command is a looser shape than LangGraph's `CommandParams`; the runtime
    // accepts the same fields, so we hand it through as the constructor params.
    return new Command(kwargs.command as CommandParams);
  }
  return kwargs.input ?? null;
}

// Configurable keys the server owns: a client must not set the checkpoint target, run/thread
// identity, LangGraph-internal (`__`-prefixed) keys, or the authenticated principal, or it could
// redirect a run to another checkpoint, spoof run wiring, or impersonate another caller. `thread_id`
// and the `langgraph_auth_*` keys are set by the server regardless (see below).
const RESERVED_CONFIGURABLE_KEYS = new Set([
  "thread_id",
  "run_id",
  "checkpoint_id",
  "checkpoint_ns",
  "checkpoint_map",
  "checkpoint",
  "langgraph_auth_user",
  "langgraph_auth_user_id",
  "langgraph_auth_permissions",
]);

function sanitizeConfigurable(
  configurable: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!configurable) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(configurable)) {
    if (RESERVED_CONFIGURABLE_KEYS.has(key) || key.startsWith("__")) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * Merge the authenticated caller into a `configurable`, matching LangGraph exactly — the three keys,
 * order, and values mirror `@langchain/langgraph-api`'s `applyAuthToRunConfig`: `langgraph_auth_user`
 * is the full user object (custom fields included), `langgraph_auth_user_id` is its `identity`, and
 * `langgraph_auth_permissions` is the caller's authenticated `scopes` (falling back to the user's
 * `permissions` when a run carries no separate scopes — the two are identical for the config-loaded
 * `Auth`). Server-owned, so it's added last and, being reserved, can't be spoofed by the client's own
 * configurable. A no-op when the run carries no principal (no auth configured) — matching
 * `langgraph dev`, so no keys appear.
 */
export function withAuthUser(
  configurable: Record<string, unknown>,
  authUser: AuthUser | undefined,
  scopes?: string[],
): Record<string, unknown> {
  if (!authUser) return configurable;
  return {
    ...configurable,
    langgraph_auth_user: authUser,
    langgraph_auth_user_id: authUser.identity,
    langgraph_auth_permissions: scopes ?? authUser.permissions,
  };
}

/**
 * The `configurable` for a graph *factory* export: the client's config with server-owned keys
 * stripped (so a factory can never be fed a spoofed `langgraph_auth_user` or a redirected checkpoint —
 * same guard the node path applies) and the authenticated caller stamped on. Returns `undefined` when
 * nothing remains, preserving the shape a factory sees for a run with no config and no principal.
 */
export function toFactoryConfigurable(kwargs: RunKwargs): Record<string, unknown> | undefined {
  const configurable = withAuthUser(
    sanitizeConfigurable(kwargs.config?.configurable),
    kwargs.auth_user,
    kwargs.auth_scopes,
  );
  return Object.keys(configurable).length > 0 ? configurable : undefined;
}

/** LangGraph call options assembled for a run. Cast to the graph's `Partial<PregelOptions>` at use. */
export interface GraphCallOptions {
  configurable: Record<string, unknown>;
  streamMode: StreamMode[];
  signal: AbortSignal;
  context?: unknown;
  recursionLimit?: number;
  interruptBefore?: string[] | "*";
  interruptAfter?: string[] | "*";
}

/**
 * Build the call options for streaming/invoking the graph. `thread_id` is threaded through
 * `configurable` so LangGraph reads and writes this thread's checkpoint (enabling state, history,
 * and interrupt/resume). The caller's own `configurable` is spread first so `thread_id` always wins.
 */
export function toGraphCallOptions(
  kwargs: RunKwargs,
  threadId: string,
  signal: AbortSignal,
): GraphCallOptions {
  const options: GraphCallOptions = {
    // Drop server-owned keys from the client's configurable, force this thread's id, add the
    // server-owned time-travel fork target (if any) *after* sanitizing so the client can never spoof
    // it, then stamp the authenticated caller so the graph can authorize off `langgraph_auth_user`.
    configurable: withAuthUser(
      {
        ...sanitizeConfigurable(kwargs.config?.configurable),
        thread_id: threadId,
        ...(kwargs.checkpoint_id !== undefined ? { checkpoint_id: kwargs.checkpoint_id } : {}),
      },
      kwargs.auth_user,
      kwargs.auth_scopes,
    ),
    streamMode: toGraphStreamModes(kwargs.stream_mode),
    signal,
  };
  if (kwargs.context !== undefined) options.context = kwargs.context;
  const recursionLimit = kwargs.config?.recursion_limit;
  if (typeof recursionLimit === "number") options.recursionLimit = recursionLimit;
  if (kwargs.interrupt_before !== undefined) options.interruptBefore = kwargs.interrupt_before;
  if (kwargs.interrupt_after !== undefined) options.interruptAfter = kwargs.interrupt_after;
  return options;
}
