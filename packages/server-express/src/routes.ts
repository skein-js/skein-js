// The Agent Protocol route table and the pure transport shim that mounts it. Paths mirror the
// `@langchain/langgraph-sdk` client (the conformance oracle), NOT the `/agents/...` spelling in
// docs/agent-protocol.md. `createHandlerRouter` adds no protocol logic: it maps each Express request
// onto the injected handler table and serializes the result. It is the reusable piece a caller with
// custom `ProtocolDeps` (e.g. Postgres + Redis for `skein up`) mounts directly.

import type { Logger, ProtocolHandlers, ProtocolRequest } from "@skein-js/agent-protocol";
import cors, { type CorsOptions } from "cors";
import express from "express";
import type { Request, Response, Router } from "express";

import { sendErrorResponse } from "./error-response.js";
import { sendProtocolResponse } from "./send-protocol-response.js";
import { toProtocolRequest } from "./to-protocol-request.js";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

interface RouteBinding {
  method: HttpMethod;
  path: string;
  handler: keyof ProtocolHandlers;
  /**
   * Fold the path `thread_id` into the request body before dispatch. The SDK addresses a
   * thread-scoped run by its path (`POST /threads/{id}/runs/stream`) while carrying only
   * `assistant_id` in the body, but the stateless run handlers read `thread_id` from the body — so a
   * thread-scoped mount must copy it across, or the run would target a stray new thread.
   */
  foldThreadIdIntoBody?: boolean;
}

/** The route table, ordered most-specific-first within each method so literals win over params. */
export const skeinRoutes: readonly RouteBinding[] = [
  // assistants — literals (search/count) before `:assistant_id`, and nested paths before the bare id.
  { method: "post", path: "/assistants/search", handler: "searchAssistants" },
  { method: "post", path: "/assistants/count", handler: "countAssistants" },
  { method: "post", path: "/assistants", handler: "createAssistant" },
  { method: "get", path: "/assistants/:assistant_id/schemas", handler: "getAssistantSchemas" },
  { method: "get", path: "/assistants/:assistant_id/graph", handler: "getAssistantGraph" },
  {
    method: "get",
    path: "/assistants/:assistant_id/subgraphs/:namespace",
    handler: "getAssistantSubgraphs",
  },
  { method: "get", path: "/assistants/:assistant_id/subgraphs", handler: "getAssistantSubgraphs" },
  { method: "post", path: "/assistants/:assistant_id/versions", handler: "listAssistantVersions" },
  {
    method: "post",
    path: "/assistants/:assistant_id/latest",
    handler: "setAssistantLatestVersion",
  },
  { method: "get", path: "/assistants/:assistant_id", handler: "getAssistant" },
  { method: "patch", path: "/assistants/:assistant_id", handler: "updateAssistant" },
  { method: "delete", path: "/assistants/:assistant_id", handler: "deleteAssistant" },

  // threads
  { method: "post", path: "/threads/search", handler: "listThreads" },
  { method: "post", path: "/threads", handler: "createThread" },
  { method: "post", path: "/threads/:thread_id/copy", handler: "copyThread" },
  { method: "get", path: "/threads/:thread_id", handler: "getThread" },
  { method: "patch", path: "/threads/:thread_id", handler: "patchThread" },
  { method: "delete", path: "/threads/:thread_id", handler: "deleteThread" },
  { method: "get", path: "/threads/:thread_id/state", handler: "getThreadState" },
  { method: "post", path: "/threads/:thread_id/history", handler: "getThreadHistory" },

  // runs — the stateless handlers are reused on the thread-scoped path with the id folded in
  { method: "post", path: "/runs/wait", handler: "createWaitRun" },
  { method: "post", path: "/runs/stream", handler: "createStreamRun" },
  {
    method: "post",
    path: "/threads/:thread_id/runs/wait",
    handler: "createWaitRun",
    foldThreadIdIntoBody: true,
  },
  {
    method: "post",
    path: "/threads/:thread_id/runs/stream",
    handler: "createStreamRun",
    foldThreadIdIntoBody: true,
  },
  { method: "post", path: "/threads/:thread_id/runs", handler: "createBackgroundRun" },
  { method: "get", path: "/threads/:thread_id/runs", handler: "listThreadRuns" },
  { method: "post", path: "/threads/:thread_id/runs/:run_id/cancel", handler: "cancelRun" },
  { method: "get", path: "/threads/:thread_id/runs/:run_id/stream", handler: "joinRunStream" },
  { method: "get", path: "/threads/:thread_id/runs/:run_id", handler: "getRun" },
  { method: "delete", path: "/threads/:thread_id/runs/:run_id", handler: "deleteRun" },
  { method: "get", path: "/runs/:run_id/stream", handler: "joinRunStream" },

  // thread streaming / commands
  { method: "post", path: "/threads/:thread_id/stream", handler: "postThreadStream" },
  { method: "get", path: "/threads/:thread_id/stream", handler: "getThreadStream" },
  { method: "post", path: "/threads/:thread_id/commands", handler: "postThreadCommands" },

  // store
  { method: "put", path: "/store/items", handler: "putStoreItem" },
  { method: "get", path: "/store/items", handler: "getStoreItem" },
  { method: "delete", path: "/store/items", handler: "deleteStoreItem" },
  { method: "post", path: "/store/items/search", handler: "searchStoreItems" },
  { method: "post", path: "/store/namespaces", handler: "listStoreNamespaces" },
];

export interface HandlerRouterOptions {
  /** Structured logger for unexpected (non-`SkeinHttpError`) faults. */
  logger?: Logger;
  /**
   * Cross-origin access, needed by browser clients (Agent Chat UI, React `useStream`) that run on a
   * different origin than the server. `true` reflects the request origin (permissive — good for
   * `skein dev`); pass `CorsOptions` to restrict origins for `skein up`; omit/`false` to disable.
   */
  cors?: boolean | CorsOptions;
}

/** Copy the path `thread_id` into an object body so a stateless run handler runs on the right thread. */
function foldThreadId(request: ProtocolRequest): ProtocolRequest {
  const threadId = request.params["thread_id"];
  if (threadId === undefined) return request;
  const base =
    typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : {};
  return { ...request, body: { ...base, thread_id: threadId } };
}

/**
 * Build an Express `Router` that binds the route table to a handler table. This is the pure shim —
 * it assembles no runtime and knows no storage driver, so callers can mount it over any
 * `ProtocolHandlers` (in-memory for `skein dev`, Postgres + Redis for `skein up`).
 */
export function createHandlerRouter(
  handlers: ProtocolHandlers,
  options: HandlerRouterOptions = {},
): Router {
  const router = express.Router();
  // CORS first, so preflight `OPTIONS` and the `Access-Control-Allow-*` headers apply to every route
  // (including the SSE streams the browser SDKs read cross-origin). `true` reflects the request
  // origin (rather than a bare `*`), which also works for credentialed requests.
  if (options.cors) router.use(cors(options.cors === true ? { origin: true } : options.cors));
  router.use(express.json());

  for (const binding of skeinRoutes) {
    const invoke = handlers[binding.handler];
    router[binding.method](binding.path, async (req: Request, res: Response) => {
      try {
        const request = toProtocolRequest(req);
        const response = await invoke(
          binding.foldThreadIdIntoBody ? foldThreadId(request) : request,
        );
        await sendProtocolResponse(response, res);
      } catch (error) {
        sendErrorResponse(error, res, options.logger);
      }
    });
  }

  return router;
}
