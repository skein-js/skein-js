// Pure translation from a LangGraph stream chunk to a `RunFrame` body. The engine always requests
// `streamMode` as an array, so every chunk arrives as a `[mode, data]` tuple — but we stay
// defensive about a bare chunk (single-mode form) so a misconfigured call degrades to an
// "updates" frame rather than throwing mid-stream.

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

/** The `event` + `data` of a frame, before the engine stamps a sequence number on it. */
export interface RunFrameBody {
  event: StreamMode;
  data: unknown;
}

/**
 * Split a stream chunk into its mode and payload. `[mode, data]` tuples (array `streamMode`) are
 * unwrapped; anything else is treated as an "updates" payload.
 */
export function chunkToFrameBody(chunk: unknown): RunFrameBody {
  if (Array.isArray(chunk) && chunk.length === 2 && isStreamMode(chunk[0])) {
    return { event: chunk[0], data: chunk[1] };
  }
  return { event: "updates", data: chunk };
}

/** Stamp a sequence number onto a frame body to produce the wire {@link RunFrame}. */
export function toRunFrame(seq: number, body: RunFrameBody): RunFrame {
  return { seq, event: body.event, data: body.data };
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
 * mirroring `@langchain/langgraph-api`:
 * - `langsmith:hidden`-tagged events are dropped entirely.
 * - an `on_chain_stream` event for *this* run carries an internal `[mode, payload]` stream chunk;
 *   it becomes a normal mode frame, but only when that mode was requested (`graphModes`).
 * - every other event (token/tool/step lifecycle) becomes an `{ event: "events", data }` frame.
 *
 * Returns `null` when the event produces no frame (hidden, or an on_chain_stream for an unrequested
 * mode). `graphModes` is the requested set with `events` already stripped.
 */
export function streamEventToFrameBody(
  event: GraphStreamEvent,
  runId: string,
  graphModes: readonly StreamMode[],
): RunFrameBody | null {
  if (event.tags?.includes("langsmith:hidden")) return null;
  if (event.event === "on_chain_stream" && event.run_id === runId) {
    const chunk = event.data?.chunk;
    if (Array.isArray(chunk) && chunk.length === 2 && isStreamMode(chunk[0])) {
      const mode = chunk[0];
      return graphModes.includes(mode) ? { event: mode, data: chunk[1] } : null;
    }
    return null;
  }
  return { event: "events", data: event };
}
