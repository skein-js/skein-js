// Pages Router adapter: `createSkeinPagesHandler(options)` returns a Next.js API route handler you
// default-export from a catch-all `pages/api/[...path].ts`. It maps the Node request onto the shared
// handler table and serializes the response back onto the Node response.
//
//   // pages/api/[...path].ts
//   import { createSkeinPagesHandler } from "@skein-js/nextjs";
//   export const config = { api: { bodyParser: true, externalResolver: true } };
//   export default createSkeinPagesHandler({ config: "./langgraph.json" });
//
// `externalResolver: true` tells Next this route streams/settles the response itself (silences the
// "API resolved without sending a response" warning for SSE).

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  copyThreadIdIntoBody,
  matchSkeinRoute,
  type ProtocolRequest,
} from "@skein-js/agent-protocol";
import {
  applyNodeCors,
  sendNodeError,
  sendNodePreflight,
  sendNodeResponse,
  stripBasePath,
  type CorsSetting,
  type SkeinRuntimeOptions,
} from "@skein-js/server-kit";

import { getSkeinRuntime } from "./runtime-singleton.js";

/** Options for the Pages Router handler: shared runtime options plus the catch-all mount path. */
export type SkeinPagesHandlerOptions = SkeinRuntimeOptions & {
  /** The path the catch-all is mounted at (stripped before matching). Defaults to `/api`. */
  basePath?: string;
};

/** The subset of a Next.js API request the adapter reads (structural, so no `next` type dependency). */
export type SkeinPagesRequest = IncomingMessage & {
  body?: unknown;
  query?: Partial<Record<string, string | string[]>>;
};

/** A Next.js API route handler. Assignable to Next's `NextApiHandler`. */
export type SkeinPagesHandler = (req: SkeinPagesRequest, res: ServerResponse) => Promise<void>;

function toQuery(url: URL): ProtocolRequest["query"] {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] as string);
  }
  return query;
}

function toSingleValueHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | undefined> {
  const flattened: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    flattened[name] = Array.isArray(value) ? value[0] : value;
  }
  return flattened;
}

/** Build the Pages Router API handler for the given options. */
export function createSkeinPagesHandler(options: SkeinPagesHandlerOptions): SkeinPagesHandler {
  const basePath = options.basePath ?? "/api";
  const logger = options.logger;

  return async (req, res) => {
    const host = req.headers.host ?? "localhost";
    // Guard the URL construction: a malformed `Host` header would otherwise throw here.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${host}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const skeinPathname = stripBasePath(url.pathname, basePath);
    if (skeinPathname === null) {
      res.writeHead(404).end();
      return;
    }

    // Resolve the runtime first (memoized) so the effective CORS can fall back to the config's
    // `http.cors`, matching the Express/Fastify adapters.
    let resolved: Awaited<ReturnType<typeof getSkeinRuntime>>;
    try {
      resolved = await getSkeinRuntime(options);
    } catch (error) {
      sendNodeError(error, res, logger, "skein Next.js");
      return;
    }
    const cors: CorsSetting | false | undefined = options.cors ?? resolved.cors;

    if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
      if (cors) sendNodePreflight(req.headers, res, cors);
      else res.writeHead(404).end();
      return;
    }
    if (cors) applyNodeCors(req.headers, res, cors);

    const match = matchSkeinRoute(req.method ?? "GET", skeinPathname);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 404, message: "Not Found" }));
      return;
    }

    try {
      const request: ProtocolRequest = {
        method: req.method ?? "GET",
        url: `${url.origin}${skeinPathname}${url.search}`,
        params: match.params,
        query: toQuery(url),
        body: req.body,
        headers: toSingleValueHeaders(req.headers),
      };
      const invoke = resolved.runtime.handlers[match.binding.handler];
      const response = await invoke(
        match.binding.foldThreadIdIntoBody ? copyThreadIdIntoBody(request) : request,
      );
      await sendNodeResponse(response, res);
    } catch (error) {
      sendNodeError(error, res, logger, "skein Next.js");
    }
  };
}
