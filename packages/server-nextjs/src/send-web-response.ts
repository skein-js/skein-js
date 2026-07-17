// Serialize a `ProtocolResponse` into a Web-standard `Response` (App Router). JSON and empty are
// trivial; SSE maps the core's `AsyncIterable<string>` onto a `ReadableStream`, tearing the run's
// frame subscription down via the stream's `cancel()` when the client disconnects. Also maps a thrown
// error onto a `Response`. `extraHeaders` carries any CORS headers to merge in.

import { SSE_HEADERS, type Logger, type ProtocolResponse } from "@skein-js/agent-protocol";
import { isSkeinHttpError, serializeWireJson } from "@skein-js/core";

/** Bridge the core's SSE string iterable to a `ReadableStream`, releasing frames on client hangup. */
function sseStream(events: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      // Client hung up: run the frame generator's `finally` to unsubscribe from the run's event bus.
      await iterator.return?.(undefined);
    },
  });
}

/** Serialize a `ProtocolResponse` into a Web `Response`, merging any `extraHeaders` (e.g. CORS). */
export function toWebResponse(
  response: ProtocolResponse,
  extraHeaders: Record<string, string> = {},
): Response {
  switch (response.kind) {
    case "json":
      // `serializeWireJson` (not `JSON.stringify`) so LangChain messages go out flattened to the wire.
      return new Response(serializeWireJson(response.body), {
        status: response.status,
        headers: { "content-type": "application/json", ...extraHeaders },
      });
    case "empty":
      return new Response(null, { status: response.status, headers: extraHeaders });
    case "sse":
      return new Response(sseStream(response.events), {
        status: response.status,
        headers: { ...SSE_HEADERS, ...extraHeaders },
      });
  }
}

/** Map a thrown error onto a Web `Response` — `SkeinHttpError` to its status, else a logged 500. */
export function webErrorResponse(
  error: unknown,
  extraHeaders: Record<string, string> = {},
  logger?: Logger,
): Response {
  const headers = { "content-type": "application/json", ...extraHeaders };
  if (isSkeinHttpError(error)) {
    return new Response(
      JSON.stringify({
        status: error.status,
        message: error.message,
        ...(error.code !== undefined ? { code: error.code } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      }),
      { status: error.status, headers },
    );
  }
  // Unexpected fault — surface it server-side (App Router has no res to attach to), then return a
  // generic 500 so no internal detail leaks to the client.
  logger?.error("Unhandled error in the skein Next.js adapter.", error);
  return new Response(JSON.stringify({ status: 500, message: "Internal Server Error" }), {
    status: 500,
    headers,
  });
}
