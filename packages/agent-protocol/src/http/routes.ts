// The Agent Protocol route table — pure, transport-neutral data that every framework adapter maps
// onto its own router. Paths mirror the `@langchain/langgraph-sdk` client (the conformance oracle),
// NOT the `/agents/...` spelling in docs/agent-protocol.md. Each binding names a method, a path with
// `:param` placeholders, and the `ProtocolHandlers` member that serves it. This table lives with the
// engine (not in a single adapter) so Express/Fastify/NestJS/Next.js share one source of truth.

import type { ProtocolHandlers, ProtocolRequest } from "../create-handlers.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface RouteBinding {
  method: HttpMethod;
  /** Path with `:param` placeholders, e.g. `/threads/:thread_id/runs/stream`. */
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

/**
 * Copy the path `thread_id` into an object body so a stateless run handler runs on the right thread.
 * A no-op when there is no `thread_id` param. Used by every adapter for the `foldThreadIdIntoBody`
 * routes, so this rule lives in one place.
 */
export function copyThreadIdIntoBody(request: ProtocolRequest): ProtocolRequest {
  const threadId = request.params["thread_id"];
  if (threadId === undefined) return request;
  const base =
    typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : {};
  return { ...request, body: { ...base, thread_id: threadId } };
}

/**
 * @deprecated Renamed to {@link copyThreadIdIntoBody} — it copies the path `thread_id` into the
 * request body. Kept for back-compat; slated for removal in a future major.
 */
export const foldThreadId = copyThreadIdIntoBody;

/** A resolved route: the matched binding plus the path params extracted from the URL. */
export interface RouteMatch {
  binding: RouteBinding;
  params: Record<string, string>;
}

// Compile each `:param` path to a named-group regex once. Anchored (`^…$`) so a literal segment can't
// be matched as a param value, and the `:param` placeholders become `[^/]+` groups.
const compiledRoutes = skeinRoutes.map((binding) => ({
  binding,
  regex: new RegExp(`^${binding.path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`),
}));

/**
 * Match a `method` + `pathname` (no query string) against the route table, returning the binding and
 * extracted path params, or `undefined` when nothing matches. Iterates in table order, which is
 * most-specific-first, so a literal segment wins over a `:param`. This is what adapters that dispatch
 * from a catch-all route (NestJS middleware, Next.js route handlers) use in place of a framework
 * router; Express/Fastify bind `skeinRoutes` to their native router instead.
 */
export function matchSkeinRoute(method: string, pathname: string): RouteMatch | undefined {
  const wanted = method.toLowerCase();
  for (const { binding, regex } of compiledRoutes) {
    if (binding.method !== wanted) continue;
    const match = regex.exec(pathname);
    if (match) return { binding, params: decodeParams(match.groups) };
  }
  return undefined;
}

/**
 * Percent-decode captured path params so catch-all adapters (NestJS, Next.js) deliver the same decoded
 * values Express/Fastify routers do (e.g. a `%20` in a `:namespace` becomes a space). A malformed
 * escape is left as-is rather than throwing.
 */
function decodeParams(groups: Record<string, string> | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(groups ?? {})) {
    try {
      params[key] = decodeURIComponent(value);
    } catch {
      params[key] = value;
    }
  }
  return params;
}
