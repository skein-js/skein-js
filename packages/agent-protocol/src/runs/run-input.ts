// Translate a stored `RunKwargs` into the two things LangGraph needs: the graph *input* (a value,
// or a `Command` when resuming) and the *call options* (thread-scoped config, stream modes, abort
// signal). Kept separate from the engine so the mapping is easy to test on its own.

import { Command, type CommandParams } from "@langchain/langgraph";
import type { RunKwargs, StreamMode } from "@skein-js/core";

/** SDK stream modes mapped to the graph's stream vocabulary. Unknown modes fall back to values. */
function toGraphMode(mode: StreamMode): StreamMode {
  // `messages-tuple` is the SDK's token-streaming alias for the graph's `messages` mode.
  if (mode === "messages-tuple") return "messages";
  // `events` requires streamEvents, not streamMode; approximate with `updates` for MVP.
  if (mode === "events") return "updates";
  return mode;
}

/** Normalize requested modes to a non-empty, de-duplicated array of graph modes. */
export function normalizeModes(mode?: StreamMode | StreamMode[]): StreamMode[] {
  const requested = mode === undefined ? [] : Array.isArray(mode) ? mode : [mode];
  const mapped = requested.map(toGraphMode);
  const deduped = [...new Set(mapped)];
  return deduped.length > 0 ? deduped : ["values"];
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
// identity, or LangGraph-internal (`__`-prefixed) keys, or it could redirect a run to another
// checkpoint or spoof run wiring. `thread_id` is set by the server regardless (see below).
const RESERVED_CONFIGURABLE_KEYS = new Set([
  "thread_id",
  "run_id",
  "checkpoint_id",
  "checkpoint_ns",
  "checkpoint_map",
  "checkpoint",
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
    // Drop server-owned keys from the client's configurable, then force this thread's id.
    configurable: { ...sanitizeConfigurable(kwargs.config?.configurable), thread_id: threadId },
    streamMode: normalizeModes(kwargs.stream_mode),
    signal,
  };
  if (kwargs.context !== undefined) options.context = kwargs.context;
  const recursionLimit = kwargs.config?.recursion_limit;
  if (typeof recursionLimit === "number") options.recursionLimit = recursionLimit;
  if (kwargs.interrupt_before !== undefined) options.interruptBefore = kwargs.interrupt_before;
  if (kwargs.interrupt_after !== undefined) options.interruptAfter = kwargs.interrupt_after;
  return options;
}
