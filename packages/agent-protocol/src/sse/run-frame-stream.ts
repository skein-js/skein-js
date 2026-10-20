// Pure translation from a LangGraph stream chunk to a `RunFrame` body. The engine always requests
// `streamMode` as an array, so every chunk arrives as a `[mode, data]` tuple — or, when the run streams
// subgraphs, a `[namespace, mode, data]` triple — but we stay defensive about a bare chunk
// (single-mode form) so a misconfigured call degrades to an "updates" frame rather than throwing
// mid-stream.
//
// Namespaces remain separate from the mode until SSE serialization, preserving `RunFrame.event`'s
// existing closed union. The transport uses upstream's `mode|segment|…` event names.

import type { RunFrame, StreamMode } from "@skein-js/core";

/** The known LangGraph stream modes we tag frames with. */
const STREAM_MODES: readonly StreamMode[] = [
  "values",
  "updates",
  "messages",
  "messages-tuple",
  "custom",
  "events",
  "debug",
];

function isStreamMode(value: unknown): value is StreamMode {
  return typeof value === "string" && (STREAM_MODES as readonly string[]).includes(value);
}

/**
 * A namespace segment becomes part of the SSE `event:` line (`mode|segment|…`), so it may hold
 * neither a line break — which would end the field and let the rest forge SSE fields of its own — nor
 * the `|` that separates segments. LangGraph's own segments (`node:task-id`) never contain either.
 */
const UNSAFE_SEGMENT = /[\r\n|]/;

function isNamespace(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((segment) => typeof segment === "string" && !UNSAFE_SEGMENT.test(segment))
  );
}

/** The `event` + `data` of a frame, before the engine stamps a sequence number on it. */
export interface RunFrameBody {
  event: StreamMode;
  /**
   * The checkpoint namespace of the (sub)graph that emitted the frame — empty for the run's own
   * graph.
   */
  namespace: string[];
  data: unknown;
}

/** Keep the mode and its namespace separate inside the engine and event bus. */
function modeFrameBody(mode: StreamMode, namespace: string[], data: unknown): RunFrameBody {
  return { event: mode, namespace, data };
}

/**
 * Split a stream chunk into its mode, namespace and payload. `[namespace, mode, data]` triples
 * (subgraph streaming) and `[mode, data]` tuples (array `streamMode`) are unwrapped; anything else is
 * treated as a root "updates" payload.
 */
export function chunkToFrameBody(chunk: unknown, subgraphs = false): RunFrameBody {
  const parts = parseStreamChunk(chunk, subgraphs);
  if (parts) return modeFrameBody(parts.mode, parts.namespace, parts.data);
  return { event: "updates", namespace: [], data: chunk };
}

/**
 * A stream chunk's mode, namespace and payload — the one parser both paths share. A
 * `[namespace, mode, data]` triple is read only when the run asked for subgraphs; a `[mode, data]`
 * pair is always read as a root frame, so a runner that ignores the `subgraphs` option still streams.
 */
function parseStreamChunk(
  chunk: unknown,
  subgraphs: boolean,
): { mode: StreamMode; namespace: string[]; data: unknown } | null {
  if (!Array.isArray(chunk)) return null;
  if (subgraphs && chunk.length === 3 && isNamespace(chunk[0]) && isStreamMode(chunk[1])) {
    return { mode: chunk[1], namespace: chunk[0], data: chunk[2] };
  }
  if (chunk.length === 2 && isStreamMode(chunk[0])) {
    return { mode: chunk[0], namespace: [], data: chunk[1] };
  }
  return null;
}

/** Stamp a sequence number onto a frame body to produce the wire {@link RunFrame}. */
export function toRunFrame(seq: number, body: RunFrameBody): RunFrame {
  return {
    seq,
    event: body.event,
    data: body.data,
    ...(body.namespace.length > 0 ? { namespace: body.namespace } : {}),
  };
}

/** The minimal shape of a LangChain `streamEvents` event the demux reads. */
export interface GraphStreamEvent {
  event: string;
  run_id?: string;
  tags?: string[];
  data?: { chunk?: unknown };
}

/**
 * Demux one `graph.streamEvents` event into at most one frame body — the `events` stream mode,
 * mirroring `@langchain/langgraph-api`'s `streamState`:
 * - `langsmith:hidden`-tagged events are dropped entirely.
 * - an `on_chain_stream` event for *this* run carries an internal stream chunk — a `[mode, payload]`
 *   pair, or with `subgraphs` a `[namespace, mode, payload]` triple — and becomes a normal (possibly
 *   namespaced) mode frame, but only when that mode was requested (`graphModes`).
 * - every other event (token/tool/step lifecycle) becomes an `{ event: "events", data }` frame.
 *
 * Only the root run's chunks are read, even with `subgraphs`. The root's stream already relays every
 * subgraph's chunk under its real namespace; a nested runnable's own `on_chain_stream` carries a
 * namespace relative to *itself* — often `[]` — so reading it too would publish a child's frames as
 * the root's, or twice. (`@langchain/langgraph-api` reads every run's chunk when `subgraphs` is set.)
 *
 * Returns `null` for hidden events or recognized chunks of an unrequested mode.
 */
export function streamEventToFrameBody(
  event: GraphStreamEvent,
  runId: string,
  graphModes: readonly StreamMode[],
  subgraphs = false,
): RunFrameBody | null {
  if (event.tags?.includes("langsmith:hidden")) return null;
  if (event.event === "on_chain_stream" && event.run_id === runId) {
    const parts = parseStreamChunk(event.data?.chunk, subgraphs);
    if (parts) {
      return graphModes.includes(parts.mode)
        ? modeFrameBody(parts.mode, parts.namespace, parts.data)
        : null;
    }
  }
  return { event: "events", namespace: [], data: event };
}
