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
export async function readJsonBody(req: NestRequest): Promise<unknown> {
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
