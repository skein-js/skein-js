// The NestJS transport shim, as middleware. It matches each request against the shared route table
// (`skeinRoutes` via `matchSkeinRoute`); a skein route is dispatched to the handler table and its
// response serialized (via server-kit's shared Node transport), while anything else is passed through
// with `next()` — so the protocol coexists with the host app's own controllers. CORS (when enabled) is
// applied only to skein routes. Adds no protocol logic. Assumes NestJS's default Express platform.

import type { IncomingMessage, ServerResponse } from "node:http";

import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { copyThreadIdIntoBody, matchSkeinRoute, type Logger } from "@skein-js/agent-protocol";
import { SkeinHttpError } from "@skein-js/core";
import {
  applyNodeCors,
  sendNodeError,
  sendNodePreflight,
  sendNodeResponse,
  type CorsSetting,
  type ResolvedProtocolRuntime,
} from "@skein-js/server-kit";

import { toProtocolRequest } from "./to-protocol-request.js";
import { SKEIN_CORS, SKEIN_LOGGER, SKEIN_RUNTIME } from "./tokens.js";

/** The Node request the middleware reads (Express request is structurally compatible). */
type NestRequest = IncomingMessage & { originalUrl?: string; body?: unknown };

/** First value of a possibly array-valued Node header. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Return the parsed request body. Uses the body the host's global parser already attached; if that is
 * absent (e.g. the host bootstrapped with `bodyParser: false`) and the request carries a JSON body,
 * read and parse it here so the adapter is self-sufficient. A malformed body is a 400, not a 500.
 */
async function readJsonBody(req: NestRequest): Promise<unknown> {
  if (req.body !== undefined) return req.body;
  const contentType = firstHeader(req.headers["content-type"]);
  if (!contentType || !contentType.includes("application/json")) return undefined;
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

@Injectable()
export class SkeinMiddleware implements NestMiddleware {
  constructor(
    @Inject(SKEIN_RUNTIME) private readonly resolved: ResolvedProtocolRuntime,
    @Inject(SKEIN_LOGGER) private readonly logger: Logger | null,
    @Inject(SKEIN_CORS) private readonly optionCors: boolean | CorsSetting | null,
  ) {}

  async use(req: NestRequest, res: ServerResponse, next: (error?: unknown) => void): Promise<void> {
    const rawUrl = req.originalUrl ?? req.url ?? "/";
    const host = req.headers.host ?? "localhost";
    // Scheme is intentionally not derived from the spoofable `x-forwarded-proto`; this URL only feeds
    // the auth handler's synthesized Request (which must not derive trust from it). Guard the parse so
    // a malformed `Host` header falls through to `next()` instead of 500-ing the whole app.
    let url: URL;
    try {
      url = new URL(rawUrl, `http://${host}`);
    } catch {
      next();
      return;
    }

    // Explicit option wins; otherwise fall back to the config's `http.cors`, else off.
    const cors: CorsSetting | false | undefined = this.optionCors ?? this.resolved.cors;
    const method = (req.method ?? "GET").toUpperCase();

    // Preflight: only answer it for a path+method that is actually a skein route, so the host app's
    // own OPTIONS handling is untouched.
    if (method === "OPTIONS") {
      const requestedMethod = firstHeader(req.headers["access-control-request-method"]);
      if (cors && requestedMethod && matchSkeinRoute(requestedMethod, url.pathname)) {
        sendNodePreflight(req.headers, res, cors);
        return;
      }
      next();
      return;
    }

    const match = matchSkeinRoute(method, url.pathname);
    if (!match) {
      next();
      return;
    }

    if (cors) applyNodeCors(req.headers, res, cors);

    try {
      const body = await readJsonBody(req);
      const request = toProtocolRequest(req, url, match.params, body);
      const invoke = this.resolved.runtime.handlers[match.binding.handler];
      const response = await invoke(
        match.binding.foldThreadIdIntoBody ? copyThreadIdIntoBody(request) : request,
      );
      await sendNodeResponse(response, res);
    } catch (error) {
      sendNodeError(error, res, this.logger ?? undefined, "skein NestJS");
    }
  }
}
