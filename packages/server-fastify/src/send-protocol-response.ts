// Serialize a `ProtocolResponse` onto a Fastify reply. JSON and empty go through the normal reply
// lifecycle; SSE takes over the raw Node response (`reply.hijack()` + `reply.raw`) and streams the
// pre-serialized event strings the core already produced (each ends `\n\n` — we never re-encode
// frames), tearing the run's frame subscription down when the client disconnects.

import { SSE_HEADERS, type ProtocolResponse } from "@skein-js/agent-protocol";
import { serializeWireJson } from "@skein-js/core";
import type { FastifyReply } from "fastify";

/** A vanished client turns writes into `EPIPE`/`ERR_STREAM_DESTROYED`; swallow them — we're closing. */
const ignoreStreamError = (): void => {};

/** Stream SSE event strings to the client, releasing the frame source the moment the client hangs up. */
async function pipeServerSentEvents(
  status: number,
  events: AsyncIterable<string>,
  reply: FastifyReply,
): Promise<void> {
  // Take the response out of Fastify's hands: we write the raw Node stream ourselves so Fastify does
  // not try to serialize a body or send its own headers.
  reply.hijack();
  const res = reply.raw;
  res.writeHead(status, SSE_HEADERS);
  // Node buffers headers until the first body write on some platforms; flush now so the client's
  // EventSource/`fetch` sees the stream open immediately.
  res.flushHeaders();

  const iterator = events[Symbol.asyncIterator]();
  let clientDisconnected = false;
  const releaseOnClientClose = (): void => {
    clientDisconnected = true;
    // Best-effort teardown: `return()` runs the frame generator's `finally`, unsubscribing from the
    // run's event bus once its next read settles.
    void Promise.resolve(iterator.return?.(undefined)).catch(ignoreStreamError);
  };
  res.once("close", releaseOnClientClose);
  res.on("error", ignoreStreamError);

  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done || clientDisconnected) break;
      res.write(next.value);
    }
  } finally {
    res.removeListener("close", releaseOnClientClose);
    if (!res.writableEnded) res.end();
  }
}

/** Write a `ProtocolResponse` back onto the Fastify `reply`, streaming when it is an SSE response. */
export async function sendProtocolResponse(
  response: ProtocolResponse,
  reply: FastifyReply,
): Promise<void> {
  switch (response.kind) {
    case "json":
      // `serializeWireJson` (not Fastify's serializer) so any LangChain messages in the body — thread
      // state, history, `runs.wait` values — go out flattened to the wire shape clients expect. We
      // send an already-serialized string, so set the content type explicitly.
      reply
        .status(response.status)
        .header("content-type", "application/json")
        .send(serializeWireJson(response.body));
      return;
    case "empty":
      reply.status(response.status).send();
      return;
    case "sse":
      await pipeServerSentEvents(response.status, response.events, reply);
      return;
  }
}
