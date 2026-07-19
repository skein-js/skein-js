// App Router adapter for the simplified serving surface: mount every declared graph as a plain
// endpoint that runs it to completion and returns its final state. Separate from
// `createSkeinRouteHandlers` on purpose — this is the whole surface for a non-chat service (no
// threads, assistants, or runs). See docs/serving-a-single-graph.md.
//
//   // app/api/invoke/[graph_id]/route.ts
//   import { createSkeinInvokeRouteHandlers } from "@skein-js/nextjs";
//   export const runtime = "nodejs";
//   export const { POST } = createSkeinInvokeRouteHandlers({ deps, basePath: "/api/invoke" });

import {
  createGraphInvokeHandler,
  type GraphInvokeOptions,
  type ProtocolRequest,
} from "@skein-js/agent-protocol";
import { SkeinHttpError } from "@skein-js/core";
import type { CorsSetting, SkeinRuntimeOptions } from "@skein-js/server-kit";

import { getSkeinInvokeDeps } from "./runtime-singleton.js";
import { toWebResponse, webErrorResponse } from "./send-web-response.js";
import { corsHeaders, preflightResponse } from "./web-cors.js";

export type SkeinInvokeRouteHandlerOptions = SkeinRuntimeOptions &
  GraphInvokeOptions & {
    /**
     * The path this route is mounted at, stripped before reading the trailing `:graph_id` segment.
     * Defaults to `/api/invoke` (i.e. `app/api/invoke/[graph_id]/route.ts`).
     */
    basePath?: string;
  };

export interface SkeinInvokeRouteHandlers {
  POST: (request: Request) => Promise<Response>;
  OPTIONS: (request: Request) => Promise<Response>;
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

/** The `graph_id` is the single path segment after the mount, or `null` when the path isn't ours. */
function graphIdFromPath(pathname: string, basePath: string): string | null {
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (!pathname.startsWith(`${prefix}/`)) return null;
  const rest = pathname.slice(prefix.length + 1);
  if (rest === "" || rest.includes("/")) return null;
  // Decode so `%20` reaches the resolver as a space, matching what the Express/Fastify routers hand
  // over. A malformed escape (`%zz`) is left as-is rather than throwing — same rule as the protocol
  // matcher's `decodeParams`; without this guard `decodeURIComponent` raises an uncaught URIError.
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/** Build the App Router handlers for the invoke surface. */
export function createSkeinInvokeRouteHandlers(
  options: SkeinInvokeRouteHandlerOptions,
): SkeinInvokeRouteHandlers {
  const basePath = options.basePath ?? "/api/invoke";
  const logger = options.logger;
  // Built once for these options (the deps behind them are memoized too), not per request.
  let invoke: ReturnType<typeof createGraphInvokeHandler> | undefined;

  const post = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const graphId = graphIdFromPath(url.pathname, basePath);
    if (graphId === null) return new Response(null, { status: 404 });

    let resolved: Awaited<ReturnType<typeof getSkeinInvokeDeps>>;
    try {
      resolved = await getSkeinInvokeDeps(options);
    } catch (error) {
      return webErrorResponse(error, {}, logger);
    }
    // Explicit `options.cors` (incl. an explicit `false`) wins; otherwise fall back to config CORS.
    const cors: CorsSetting | false | undefined =
      options.cors ?? (resolved.cors as CorsSetting | undefined);
    const extraHeaders = cors ? corsHeaders(request, cors) : {};

    try {
      const text = await request.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw SkeinHttpError.badRequest("Request body is not valid JSON.");
      }
      invoke ??= createGraphInvokeHandler(resolved.deps, { streamMode: options.streamMode });
      const response = await invoke({
        method: request.method,
        url: `${url.origin}${url.pathname}${url.search}`,
        params: { graph_id: graphId },
        query: toQuery(url),
        body,
        headers: Object.fromEntries(request.headers),
        // The Web `Request` aborts this when the client goes away, so the graph stops with it.
        signal: request.signal,
      });
      return toWebResponse(response, extraHeaders);
    } catch (error) {
      return webErrorResponse(error, extraHeaders, logger);
    }
  };

  const optionsHandler = async (request: Request): Promise<Response> => {
    let cors: CorsSetting | false | undefined = options.cors;
    if (cors === undefined) {
      try {
        cors = (await getSkeinInvokeDeps(options)).cors as CorsSetting | undefined;
      } catch {
        cors = undefined;
      }
    }
    return cors ? preflightResponse(request, cors) : new Response(null, { status: 404 });
  };

  return { POST: post, OPTIONS: optionsHandler };
}
