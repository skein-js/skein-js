// Serialize a `ProtocolResponse` onto an Express response. JSON and empty are trivial; SSE streams
// the pre-serialized event strings the core already produced (each ends `\n\n` — we never re-encode
// frames) and tears the run's frame subscription down when the client disconnects.

import {
  SSE_HEADERS,
  writeWithBackpressure,
  type ProtocolResponse,
} from "@skein-js/agent-protocol";
import { serializeWireJson } from "@skein-js/core";
import type { Response } from "express";

/** A vanished client turns writes into `EPIPE`/`ERR_STREAM_DESTROYED`; swallow them — we're closing. */
const ignoreStreamError = (): void => {};

/** Stream SSE event strings to the client, releasing the frame source the moment the client hangs up. */
async function pipeServerSentEvents(
  status: number,
  events: AsyncIterable<string>,
  res: Response,
  headers: Record<string, string> = {},
): Promise<void> {
  res.status(status);
  for (const [name, value] of Object.entries(SSE_HEADERS)) res.setHeader(name, value);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.flushHeaders();

  const iterator = events[Symbol.asyncIterator]();
  let clientDisconnected = false;
  const releaseOnClientClose = (): void => {
    clientDisconnected = true;
    // Best-effort teardown: `return()` runs the frame generator's `finally`, unsubscribing from the
    // run's event bus once its next read settles. Guard the promise so a rejecting teardown (e.g. a
    // future networked frame source) can't surface as an unhandled rejection.
    void Promise.resolve(iterator.return?.(undefined)).catch(ignoreStreamError);
  };
  res.once("close", releaseOnClientClose);
  res.on("error", ignoreStreamError);

  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done || clientDisconnected) break;
      // Pace the loop to the client. Ignoring `write`'s return value would let a fast graph queue its
      // entire output in this socket's buffer for a client that cannot keep up.
      const drained = writeWithBackpressure(res, next.value);
      if (drained) await drained;
    }
  } finally {
    res.removeListener("close", releaseOnClientClose);
    if (!res.writableEnded) res.end();
  }
}

/** Write a `ProtocolResponse` back onto the Express `res`, streaming when it is an SSE response. */
export async function sendProtocolResponse(
  response: ProtocolResponse,
  res: Response,
): Promise<void> {
  switch (response.kind) {
    case "json":
      // `serializeWireJson` (not `res.json`) so any LangChain messages in the body — thread state,
      // history, `runs.wait` values — go out flattened to the wire shape clients expect.
      res
        .status(response.status)
        .set(response.headers ?? {})
        .type("application/json")
        .send(serializeWireJson(response.body));
      return;
    case "empty":
      res
        .status(response.status)
        .set(response.headers ?? {})
        .end();
      return;
    case "sse":
      await pipeServerSentEvents(response.status, response.events, res, response.headers);
      return;
  }
}
