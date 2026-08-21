// Reading a request body under NestJS, shared by both transport middlewares (the protocol table and
// the simplified invoke surface) so they treat a missing global body parser identically.

import type { IncomingMessage } from "node:http";

import { SkeinHttpError } from "@skein-js/core";

/** The Node request the middlewares read (an Express request is structurally compatible). */
export type NestRequest = IncomingMessage & { originalUrl?: string; body?: unknown };

/**
 * Return the parsed request body. Uses the body the host's global parser already attached; if that is
 * absent (e.g. the host bootstrapped with `bodyParser: false`) and the request carries a JSON body,
 * read and parse it here so the adapter is self-sufficient. A malformed body is a 400, not a 500.
 */
export async function readJsonBody(req: NestRequest, retainRawBody = false): Promise<unknown> {
  if (retainRawBody) return readRawBody(req);
  if (req.body !== undefined) return req.body;
  const contentType = req.headers["content-type"];
  const single = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!single || !single.includes("application/json")) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw SkeinHttpError.badRequest("Request body is not valid JSON.");
  }
}

/**
 * The body as text, for a route that verifies a signature over it.
 *
 * The host's global parser is a real problem here rather than a detail: NestJS bootstraps with one by
 * default, and once it has consumed the stream the bytes are gone. Re-serializing what it produced
 * does not reproduce them — key order, whitespace and number formatting are not guaranteed to
 * round-trip — so a signature check would fail on every genuine request. Better to say so than to
 * hand a channel something that looks right and cannot be verified.
 */
async function readRawBody(req: NestRequest): Promise<string> {
  if (req.body !== undefined) {
    throw SkeinHttpError.badRequest(
      "This route needs the unparsed request body, but a body parser has already consumed it. " +
        "Bootstrap NestJS with `{ bodyParser: false }`, or exclude the channel routes from it.",
      { code: "raw_body_unavailable" },
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
