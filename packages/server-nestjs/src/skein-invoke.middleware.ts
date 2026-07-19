// The NestJS transport shim for the simplified serving surface. Same shape as `SkeinMiddleware`: it
// matches the invoke route and dispatches it, and calls `next()` for everything else — so the
// endpoint coexists with the host app's own controllers. Adds no protocol logic.

import type { ServerResponse } from "node:http";

import { Inject, Injectable, Optional, type NestMiddleware } from "@nestjs/common";
import { ApplicationConfig } from "@nestjs/core";
import type {
  GraphInvokeHandlerName,
  Logger,
  ProtocolHandler,
  RouteMatcher,
} from "@skein-js/agent-protocol";
import {
  applyNodeCors,
  sendNodeError,
  sendNodePreflight,
  sendNodeResponse,
  stripBasePath,
  type CorsSetting,
} from "@skein-js/server-kit";

import { readJsonBody, type NestRequest } from "./read-json-body.js";
import { toProtocolRequest } from "./to-protocol-request.js";
import { SKEIN_CORS, SKEIN_INVOKE, SKEIN_LOGGER } from "./tokens.js";

/** The resolved invoke surface the module provides: the handler plus its route matcher and CORS. */
export interface ResolvedInvokeSurface {
  handler: ProtocolHandler;
  match: RouteMatcher<GraphInvokeHandlerName>;
  /** CORS derived from the config's `http.cors`, when the `{ config }` path was used. */
  cors?: CorsSetting;
}

@Injectable()
export class SkeinInvokeMiddleware implements NestMiddleware {
  constructor(
    @Inject(SKEIN_INVOKE) private readonly invoke: ResolvedInvokeSurface,
    @Inject(SKEIN_LOGGER) private readonly logger: Logger | null,
    @Inject(SKEIN_CORS) private readonly optionCors: boolean | CorsSetting | null,
    // Explicit token: this package builds without `emitDecoratorMetadata` (see tsconfig.json).
    // `@Optional()` keeps hand-wired construction working — see `SkeinMiddleware`.
    @Optional() @Inject(ApplicationConfig) private readonly appConfig?: ApplicationConfig,
  ) {}

  async use(req: NestRequest, res: ServerResponse, next: (error?: unknown) => void): Promise<void> {
    const rawUrl = req.originalUrl ?? req.url ?? "/";
    const host = req.headers.host ?? "localhost";
    // Scheme is intentionally not derived from the spoofable `x-forwarded-proto`; this URL only feeds
    // the auth handler's synthesized Request. A malformed `Host` falls through rather than 500-ing.
    let url: URL;
    try {
      url = new URL(rawUrl, `http://${host}`);
    } catch {
      next();
      return;
    }

    // Strip `app.setGlobalPrefix()` — Nest bakes it into the mount path but leaves it on the request,
    // and the invoke route is anchored at the mount root. See `SkeinMiddleware` for the full rationale.
    const skeinPathname = stripBasePath(url.pathname, this.appConfig?.getGlobalPrefix() ?? "");
    if (skeinPathname === null) {
      next();
      return;
    }

    // Explicit option wins; otherwise fall back to the config's `http.cors`, else off.
    const cors: CorsSetting | false | undefined = this.optionCors ?? this.invoke.cors;
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "OPTIONS") {
      const requested = Array.isArray(req.headers["access-control-request-method"])
        ? req.headers["access-control-request-method"][0]
        : req.headers["access-control-request-method"];
      if (cors && requested && this.invoke.match(requested, skeinPathname)) {
        sendNodePreflight(req.headers, res, cors);
        return;
      }
      next();
      return;
    }

    const match = this.invoke.match(method, skeinPathname);
    if (!match) {
      next();
      return;
    }

    if (cors) applyNodeCors(req.headers, res, cors);

    // Abort the graph when the client goes away, so a disconnect doesn't leave it running to
    // completion (burning model tokens) for a response nobody will read.
    const disconnected = new AbortController();
    res.once("close", () => disconnected.abort(new Error("client disconnected")));

    try {
      const body = await readJsonBody(req);
      const request = {
        ...toProtocolRequest(req, url, match.params, body),
        signal: disconnected.signal,
      };
      await sendNodeResponse(await this.invoke.handler(request), res);
    } catch (error) {
      sendNodeError(error, res, this.logger ?? undefined, "skein NestJS invoke");
    }
  }
}
