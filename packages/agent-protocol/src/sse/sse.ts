// Serialize a stream of `RunFrame`s into Server-Sent Events text. Core produces the frames; each
// framework adapter just writes these strings to the response with `Content-Type:
// text/event-stream`. The terminal `end`/`error` event is synthesized here (a `RunFrame.event`
// can't be `"end"`), read from the run's final status once the frame iterator completes.
// See docs/streaming.md.

import type { RunFrame, RunStatus } from "@skein-js/core";

/** SSE response headers an adapter should set before writing the event stream. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};

/** Serialize one frame as an SSE block: `id:` for reconnect, `event:` name, JSON `data:`. */
export function encodeFrame(frame: RunFrame): string {
  return `id: ${frame.seq}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
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
