// Serialize a `ProtocolResponse` (and thrown errors) onto a Node `ServerResponse` — the transport
// shared by adapters whose response object is (or extends) Node's `ServerResponse`: the NestJS
// middleware (Express platform) and the Next.js Pages Router. JSON and empty are trivial; SSE streams
// the pre-serialized frames the engine produced (each ends `\n\n` — never re-encoded) and tears the
// run's frame subscription down when the client disconnects. Express/Fastify keep their own
// framework-native serializers; this is the one Node-`http` copy the two Node-based adapters share.

import type { ServerResponse } from "node:http";

import { SSE_HEADERS, type Logger, type ProtocolResponse } from "@skein-js/agent-protocol";
import { isSkeinHttpError, serializeWireJson } from "@skein-js/core";

/** A vanished client turns writes into `EPIPE`/`ERR_STREAM_DESTROYED`; swallow them — we're closing. */
const ignoreStreamError = (): void => {};

async function pipeServerSentEvents(
  status: number,
  events: AsyncIterable<string>,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(status, SSE_HEADERS);
  res.flushHeaders();

  const iterator = events[Symbol.asyncIterator]();
  let clientDisconnected = false;
  const releaseOnClientClose = (): void => {
    clientDisconnected = true;
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

/** Write a `ProtocolResponse` back onto the Node `res`, streaming when it is an SSE response. */
export async function sendNodeResponse(
  response: ProtocolResponse,
  res: ServerResponse,
): Promise<void> {
  switch (response.kind) {
    case "json":
      // `serializeWireJson` (not `res.json`) so any LangChain messages in the body go out flattened
      // to the wire shape clients expect.
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(serializeWireJson(response.body));
      return;
    case "empty":
      res.writeHead(response.status).end();
      return;
    case "sse":
      await pipeServerSentEvents(response.status, response.events, res);
      return;
  }
}

/** Serialize a caught error onto the Node `res`, using the protocol status when the error carries one. */
export function sendNodeError(
  error: unknown,
  res: ServerResponse,
  logger?: Logger,
  adapterName = "skein",
): void {
  if (res.headersSent) {
    if (!isSkeinHttpError(error)) logger?.error("Unhandled error after headers were sent.", error);
    if (!res.writableEnded) res.end();
    return;
  }
  if (isSkeinHttpError(error)) {
    res.writeHead(error.status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: error.status,
        message: error.message,
        ...(error.code !== undefined ? { code: error.code } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      }),
    );
    return;
  }
  logger?.error(`Unhandled error in the ${adapterName} adapter.`, error);
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: 500, message: "Internal Server Error" }));
}
