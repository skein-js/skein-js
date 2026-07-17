// Map a thrown error onto a Fastify reply. `SkeinHttpError` carries the intended status and is
// serialized as `{ status, message, code?, details? }`; anything else is an unexpected fault → 500.
// Once the SSE stream has hijacked the raw response (headers flushed) we can only end it, not rewrite
// its status.

import type { Logger } from "@skein-js/agent-protocol";
import { isSkeinHttpError } from "@skein-js/core";
import type { FastifyReply } from "fastify";

/** Serialize a caught error onto `reply`, using the protocol status when the error carries one. */
export function sendErrorResponse(error: unknown, reply: FastifyReply, logger?: Logger): void {
  // An SSE response hijacks the raw stream; once that happened Fastify's reply is no longer in play.
  if (reply.raw.headersSent || reply.sent) {
    if (!isSkeinHttpError(error)) logger?.error("Unhandled error after headers were sent.", error);
    if (!reply.raw.writableEnded) reply.raw.end();
    return;
  }

  if (isSkeinHttpError(error)) {
    reply.status(error.status).send({
      status: error.status,
      message: error.message,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
    return;
  }

  logger?.error("Unhandled error in the skein Fastify adapter.", error);
  reply.status(500).send({ status: 500, message: "Internal Server Error" });
}
