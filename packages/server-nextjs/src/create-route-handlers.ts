// App Router adapter: `createSkeinRouteHandlers(options)` returns the per-method Route Handlers you
// re-export from a catch-all `app/<base>/[...path]/route.ts`. Each maps the incoming Web `Request`
// onto the shared handler table and serializes the `ProtocolResponse` back to a Web `Response`.
//
//   // app/api/[...path]/route.ts
//   import { createSkeinRouteHandlers } from "@skein-js/nextjs";
//   export const runtime = "nodejs"; // the background worker needs a long-lived Node process
//   export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } =
//     createSkeinRouteHandlers({ config: "./langgraph.json" });

import {
  copyThreadIdIntoBody,
  matchSkeinRoute,
  type ProtocolRequest,
} from "@skein-js/agent-protocol";
import { SkeinHttpError } from "@skein-js/core";
import type { CorsSetting, SkeinRuntimeOptions } from "@skein-js/server-kit";

import { getSkeinRuntime } from "./runtime-singleton.js";
import { toWebResponse, webErrorResponse } from "./send-web-response.js";
import { corsHeaders, preflightResponse } from "./web-cors.js";

/** Options for the App Router handlers: the shared runtime options plus where the catch-all is mounted. */
export type SkeinRouteHandlerOptions = SkeinRuntimeOptions & {
  /**
   * The path the catch-all route is mounted at, stripped before matching the protocol route table.
   * Defaults to `/api` (i.e. `app/api/[...path]/route.ts`). Set to `""` or `/` if you mount the
   * catch-all at the app root.
   */
  basePath?: string;
};

/** A single Route Handler: takes the Web `Request` and returns a Web `Response`. */
export type SkeinRouteHandler = (request: Request) => Promise<Response>;

export interface SkeinRouteHandlers {
  GET: SkeinRouteHandler;
  POST: SkeinRouteHandler;
  PUT: SkeinRouteHandler;
  PATCH: SkeinRouteHandler;
  DELETE: SkeinRouteHandler;
  OPTIONS: SkeinRouteHandler;
}

/** Strip the mount `basePath` from a pathname, or `null` when the path is not under the mount. */
function stripBasePath(pathname: string, basePath: string): string | null {
  if (basePath === "" || basePath === "/") return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return null;
}

/** Query params from a URL, keeping repeated keys as `string[]`. */
function toQuery(url: URL): ProtocolRequest["query"] {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] as string);
  }
  return query;
}

/** Build a `ProtocolRequest` from a Web `Request`, a stripped skein path, and matched path params. */
async function toProtocolRequest(
  request: Request,
  url: URL,
  skeinPathname: string,
  params: Record<string, string>,
): Promise<ProtocolRequest> {
  let body: unknown;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const text = await request.text();
    // A malformed JSON body is a client error (400), not an unexpected server fault (500).
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw SkeinHttpError.badRequest("Request body is not valid JSON.");
    }
  }
  return {
    method: request.method,
    // Report the skein-relative absolute URL (mount prefix stripped) so auth handlers see the same
    // path shape the other adapters produce.
    url: `${url.origin}${skeinPathname}${url.search}`,
    params,
    query: toQuery(url),
    body,
    headers: Object.fromEntries(request.headers),
  };
}

/** Build the App Router Route Handlers for the given options. */
export function createSkeinRouteHandlers(options: SkeinRouteHandlerOptions): SkeinRouteHandlers {
  const basePath = options.basePath ?? "/api";
  const logger = options.logger;

  const dispatchRequest: SkeinRouteHandler = async (request) => {
    const url = new URL(request.url);
    const skeinPathname = stripBasePath(url.pathname, basePath);
    if (skeinPathname === null) return new Response(null, { status: 404 });

    // Resolve the runtime first (memoized) so the effective CORS can fall back to the config's
    // `http.cors` — matching the Express/Fastify adapters — rather than only honoring `options.cors`.
    let resolved: Awaited<ReturnType<typeof getSkeinRuntime>>;
    try {
      resolved = await getSkeinRuntime(options);
    } catch (error) {
      return webErrorResponse(error, {}, logger);
    }
    // Explicit `options.cors` (incl. an explicit `false`) wins; otherwise fall back to config CORS.
    const cors: CorsSetting | false | undefined = options.cors ?? resolved.cors;

    if (request.method === "OPTIONS") {
      return cors ? preflightResponse(request, cors) : new Response(null, { status: 404 });
    }

    const extraHeaders = cors ? corsHeaders(request, cors) : {};

    const match = matchSkeinRoute(request.method, skeinPathname);
    if (!match) {
      return new Response(JSON.stringify({ status: 404, message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json", ...extraHeaders },
      });
    }

    try {
      const request_ = await toProtocolRequest(request, url, skeinPathname, match.params);
      const invoke = resolved.runtime.handlers[match.binding.handler];
      const response = await invoke(
        match.binding.foldThreadIdIntoBody ? copyThreadIdIntoBody(request_) : request_,
      );
      return toWebResponse(response, extraHeaders);
    } catch (error) {
      return webErrorResponse(error, extraHeaders, logger);
    }
  };

  return {
    GET: dispatchRequest,
    POST: dispatchRequest,
    PUT: dispatchRequest,
    PATCH: dispatchRequest,
    DELETE: dispatchRequest,
    OPTIONS: dispatchRequest,
  };
}
