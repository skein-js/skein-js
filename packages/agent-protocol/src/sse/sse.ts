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
 * Turn a frame iterable into an SSE string iterable, appending a terminal `end`/`error` event read
 * from `finalStatus()` once the frames are exhausted (the bus closed). `finalStatus` is called
 * lazily at the end so it reflects the run's terminal row, not its status when streaming began.
 */
export async function* toSseEvents(
  frames: AsyncIterable<RunFrame>,
  finalStatus: () => Promise<RunStatus | null>,
): AsyncIterable<string> {
  let sawErrorFrame = false;
  for await (const frame of frames) {
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
