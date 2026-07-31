// Serialize a stream of `RunFrame`s into Server-Sent Events text. Core produces the frames; each
// framework adapter just writes these strings to the response with `Content-Type:
// text/event-stream`. The terminal `end`/`error` event is synthesized here (a `RunFrame.event`
// can't be `"end"`), read from the run's final status once the frame iterator completes.
// See docs/streaming.md.

import { serializeWireJson, type RunFrame, type RunStatus } from "@skein-js/core";

/** SSE response headers an adapter should set before writing the event stream. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};

/**
 * Encoded blocks, keyed by the frame object they came from.
 *
 * The in-process bus hands the *same* `RunFrame` to every subscriber on a run, so two clients watching
 * one run — a `useStream` view plus a `GET /runs/{id}/stream` join, say — would otherwise serialize
 * every frame twice. Weakly held, so an entry goes as soon as the bus releases the frame; there is
 * nothing to evict and nothing to bound.
 *
 * Roughly neutral for a single subscriber and worth ~48% of encode time at two, ~73% at four. The
 * Redis bus gets no benefit (each subscriber parses its own object off pub/sub, so the keys differ)
 * and pays only the failed lookup.
 */
const encodedFrames = new WeakMap<RunFrame, string>();

/** Serialize one frame as an SSE block: `id:` for reconnect, `event:` name, JSON `data:`. */
export function encodeFrame(frame: RunFrame): string {
  const cached = encodedFrames.get(frame);
  if (cached !== undefined) return cached;
  // `serializeWireJson` (not bare `JSON.stringify`) so streamed LangChain messages reach the client
  // as `{ type: "ai", content }` — the shape `useStream` / Agent Chat UI read.
  const encoded = `id: ${frame.seq}\nevent: ${frame.event}\ndata: ${serializeWireJson(frame.data)}\n\n`;
  encodedFrames.set(frame, encoded);
  return encoded;
}

/** Serialize the synthesized terminal event from a run's final status. */
export function encodeTerminal(status: RunStatus): string {
  const event = status === "error" || status === "timeout" ? "error" : "end";
  return `event: ${event}\ndata: ${JSON.stringify({ status })}\n\n`;
}

/**
 * An SSE **comment**, written during an idle gap to keep the connection alive.
 *
 * A line starting with `:` is spec-defined as ignorable, so no client — `EventSource`, the LangGraph
 * SDK, or a hand-rolled reader — dispatches it as an event. It exists for the machinery in between: a
 * proxy or load balancer that closes a connection with no bytes on it, and the SDK's
 * `stream_idle_reconnect: "auto"`, which needs traffic to distinguish "still thinking" from "dead".
 */
export const SSE_HEARTBEAT = ": heartbeat\n\n";

/**
 * How long a stream may go without bytes before a heartbeat is written. Well under the 60s idle
 * timeout common to nginx, ALB, and Cloud Run, so a slow first token cannot be mistaken for a dead
 * connection — and long enough that a normal token stream never emits one.
 */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

/** Tuning for {@link toSseEvents}. */
export interface SseOptions {
  /** Idle gap before a {@link SSE_HEARTBEAT}. `0` (or negative) disables heartbeats entirely. */
  heartbeatMs?: number;
}

/** An idle tick from {@link withIdleTicks} — a heartbeat is due. Distinct from any real frame. */
const IDLE_TICK = Symbol("idle-tick");

/**
 * Re-yield `frames`, injecting an {@link IDLE_TICK} whenever `heartbeatMs` passes with no frame.
 *
 * The in-flight `next()` is deliberately held across idle turns. An async iterator rejects a second
 * `next()` while the first is unsettled, and abandoning the promise would drop the frame it later
 * yields — so the losing side of the race is kept, not re-issued.
 */
async function* withIdleTicks(
  frames: AsyncIterable<RunFrame>,
  heartbeatMs: number,
): AsyncIterable<RunFrame | typeof IDLE_TICK> {
  const iterator = frames[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<RunFrame>> | undefined;
  try {
    for (;;) {
      pending ??= iterator.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof IDLE_TICK>((resolve) => {
        timer = setTimeout(() => resolve(IDLE_TICK), heartbeatMs);
      });
      let settled: IteratorResult<RunFrame> | typeof IDLE_TICK;
      try {
        settled = await Promise.race([pending, idle]);
      } finally {
        // Cleared on the throwing path too, so a failed frame iterator cannot leave a timer holding
        // the event loop open for the rest of the interval.
        clearTimeout(timer);
      }
      if (settled === IDLE_TICK) {
        yield IDLE_TICK; // `pending` stays in flight and is raced again next turn
        continue;
      }
      pending = undefined;
      if (settled.done === true) return;
      yield settled.value;
    }
  } finally {
    // A consumer that hung up or broke out must tear the subscription down rather than leave it
    // live-tailing a run nobody reads.
    await iterator.return?.();
  }
}

/**
 * Turn a frame iterable into an SSE string iterable, appending a terminal `end`/`error` event read
 * from `finalStatus()` once the frames are exhausted (the bus closed). `finalStatus` is called
 * lazily at the end so it reflects the run's terminal row, not its status when streaming began.
 *
 * Idle gaps are filled with {@link SSE_HEARTBEAT} every {@link DEFAULT_SSE_HEARTBEAT_MS} unless
 * `options.heartbeatMs` says otherwise; pass `0` to write only real frames.
 */
export async function* toSseEvents(
  frames: AsyncIterable<RunFrame>,
  finalStatus: () => Promise<RunStatus | null>,
  options: SseOptions = {},
): AsyncIterable<string> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  let sawErrorFrame = false;
  for await (const frame of heartbeatMs > 0 ? withIdleTicks(frames, heartbeatMs) : frames) {
    if (frame === IDLE_TICK) {
      yield SSE_HEARTBEAT;
      continue;
    }
    if (frame.event === "error") sawErrorFrame = true;
    yield encodeFrame(frame);
  }
  const status = await finalStatus();
  // Default to "success" only if the run row vanished (deleted mid-stream); otherwise report truth.
  const terminal = status ?? "success";
  // A genuine graph error already emitted an `error` frame carrying the detail — that frame *is* the
  // stream terminator, so don't append a second, redundant `error` event. (timeout/cancel publish no
  // error frame, so they still need the synthesized terminal.)
  if ((terminal === "error" || terminal === "timeout") && sawErrorFrame) return;
  yield encodeTerminal(terminal);
}

/**
 * Parse a `Last-Event-ID` header into an `afterSeq` for {@link RunEventBus.subscribe}. A missing or
 * malformed header means "from the beginning" (`0`), so a fresh connection replays everything.
 */
export function parseAfterSeq(lastEventId: string | undefined): number {
  if (lastEventId === undefined) return 0;
  const parsed = Number.parseInt(lastEventId, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}
