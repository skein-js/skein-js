// The Agent Protocol route table — pure, transport-neutral data that every framework adapter maps
// onto its own router. Paths mirror the `@langchain/langgraph-sdk` client (the conformance oracle),
// NOT the `/agents/...` spelling in docs/agent-protocol.md. Each binding names a method, a path with
// `:param` placeholders, and the `ProtocolHandlers` member that serves it. This table lives with the
// engine (not in a single adapter) so Express/Fastify/NestJS/Next.js share one source of truth.

import type { ProtocolHandlers, ProtocolRequest } from "../create-handlers.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/**
 * The resource family a route belongs to, and the unit `langgraph.json`'s `http.disable_*` flags switch
 * off. Grouped the way LangGraph groups its route *files*, not by path prefix — so
 * `/threads/{id}/runs/...` is `runs`, not `threads`, and `disable_runs` removes it exactly as
 * `langgraph dev` would.
 */
export type RouteGroup = "assistants" | "threads" | "runs" | "crons" | "store" | "meta";

/**
 * One route. `HandlerName` defaults to a member of the protocol handler table; a surface mounted
 * outside that table (the single-graph invoke endpoint) parameterizes it with its own handler names,
 * so `handler` never has to lie about being a `keyof ProtocolHandlers` an adapter could look up.
 */
export interface RouteBinding<HandlerName = keyof ProtocolHandlers> {
  method: HttpMethod;
  /** Path with `:param` placeholders, e.g. `/threads/:thread_id/runs/stream`. */
  path: string;
  handler: HandlerName;
  /**
   * Which `http.disable_*` flag removes this route. Optional so a table outside the protocol (the
   * invoke surface) need not invent a group; an ungrouped route is never disabled.
   */
  group?: RouteGroup;
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
  { method: "post", path: "/assistants/search", handler: "searchAssistants", group: "assistants" },
  { method: "post", path: "/assistants/count", handler: "countAssistants", group: "assistants" },
  { method: "post", path: "/assistants", handler: "createAssistant", group: "assistants" },
  {
    method: "get",
    path: "/assistants/:assistant_id/schemas",
    handler: "getAssistantSchemas",
    group: "assistants",
  },
  {
    method: "get",
    path: "/assistants/:assistant_id/graph",
    handler: "getAssistantGraph",
    group: "assistants",
  },
  {
    method: "get",
    path: "/assistants/:assistant_id/subgraphs/:namespace",
    handler: "getAssistantSubgraphs",
    group: "assistants",
  },
  {
    method: "get",
    path: "/assistants/:assistant_id/subgraphs",
    handler: "getAssistantSubgraphs",
    group: "assistants",
  },
  {
    method: "post",
    path: "/assistants/:assistant_id/versions",
    handler: "listAssistantVersions",
    group: "assistants",
  },
  {
    method: "post",
    path: "/assistants/:assistant_id/latest",
    handler: "setAssistantLatestVersion",
    group: "assistants",
  },
  {
    method: "get",
    path: "/assistants/:assistant_id",
    handler: "getAssistant",
    group: "assistants",
  },
  {
    method: "patch",
    path: "/assistants/:assistant_id",
    handler: "updateAssistant",
    group: "assistants",
  },
  {
    method: "delete",
    path: "/assistants/:assistant_id",
    handler: "deleteAssistant",
    group: "assistants",
  },

  // threads
  { method: "post", path: "/threads/search", handler: "listThreads", group: "threads" },
  { method: "post", path: "/threads/count", handler: "countThreads", group: "threads" },
  { method: "post", path: "/threads/prune", handler: "pruneThreads", group: "threads" },
  { method: "post", path: "/threads", handler: "createThread", group: "threads" },
  { method: "post", path: "/threads/:thread_id/copy", handler: "copyThread", group: "threads" },
  { method: "get", path: "/threads/:thread_id", handler: "getThread", group: "threads" },
  { method: "patch", path: "/threads/:thread_id", handler: "patchThread", group: "threads" },
  { method: "delete", path: "/threads/:thread_id", handler: "deleteThread", group: "threads" },
  { method: "get", path: "/threads/:thread_id/state", handler: "getThreadState", group: "threads" },
  {
    method: "post",
    path: "/threads/:thread_id/state",
    handler: "updateThreadState",
    group: "threads",
  },
  {
    method: "get",
    path: "/threads/:thread_id/state/:checkpoint_id",
    handler: "getThreadStateAtCheckpoint",
    group: "threads",
  },
  // The SDK's `threads.getState(id, checkpoint)` splits on the argument's *type*: a bare string id
  // goes to the GET above, while a checkpoint **object** (one carrying `checkpoint_ns`, i.e. subgraph
  // state) is POSTed here instead. Serving only the GET form 404s every object-shaped read.
  {
    method: "post",
    path: "/threads/:thread_id/state/checkpoint",
    handler: "getThreadStateAtCheckpointFromBody",
    group: "threads",
  },
  {
    method: "post",
    path: "/threads/:thread_id/history",
    handler: "getThreadHistory",
    group: "threads",
  },
  // `@langchain/langgraph-api` registers history on both verbs; the SDK only ever sends POST. The GET
  // costs one line because the handler already reads `?limit=` and tolerates an absent body.
  {
    method: "get",
    path: "/threads/:thread_id/history",
    handler: "getThreadHistory",
    group: "threads",
  },

  // crons — a LangGraph Platform extension, not part of the open Agent Protocol spec.
  //
  // These MUST precede the `/runs/...` bindings below. `/runs` itself is an anchored literal so it
  // cannot shadow `/runs/crons`, but `/runs/crons/search` and `/runs/crons/count` are literals
  // competing with the `/runs/crons/:cron_id` parameter path, and the matcher takes the first
  // binding that matches — so a literal must come before the `:param` that would swallow it.
  { method: "post", path: "/runs/crons/search", handler: "searchCrons", group: "crons" },
  { method: "post", path: "/runs/crons/count", handler: "countCrons", group: "crons" },
  { method: "post", path: "/runs/crons", handler: "createCron", group: "crons" },
  { method: "get", path: "/runs/crons/:cron_id", handler: "getCron", group: "crons" },
  { method: "patch", path: "/runs/crons/:cron_id", handler: "updateCron", group: "crons" },
  { method: "delete", path: "/runs/crons/:cron_id", handler: "deleteCron", group: "crons" },
  {
    method: "post",
    path: "/threads/:thread_id/runs/crons",
    handler: "createCron",
    group: "crons",
    foldThreadIdIntoBody: true,
  },

  // runs — the stateless handlers are reused on the thread-scoped path with the id folded in.
  // `/runs/wait|stream|batch|cancel` and bare `/runs` are all literal paths, so their relative order
  // does not matter (each regex is anchored); they are grouped by resource for readability.
  { method: "post", path: "/runs/wait", handler: "createWaitRun", group: "runs" },
  { method: "post", path: "/runs/stream", handler: "createStreamRun", group: "runs" },
  { method: "post", path: "/runs/batch", handler: "createRunBatch", group: "runs" },
  { method: "post", path: "/runs/cancel", handler: "cancelManyRuns", group: "runs" },
  { method: "post", path: "/runs", handler: "createStatelessRun", group: "runs" },
  {
    method: "post",
    path: "/threads/:thread_id/runs/wait",
    handler: "createWaitRun",
    group: "runs",
    foldThreadIdIntoBody: true,
  },
  {
    method: "post",
    path: "/threads/:thread_id/runs/stream",
    handler: "createStreamRun",
    group: "runs",
    foldThreadIdIntoBody: true,
  },
  {
    method: "post",
    path: "/threads/:thread_id/runs",
    handler: "createBackgroundRun",
    group: "runs",
  },
  { method: "get", path: "/threads/:thread_id/runs", handler: "listThreadRuns", group: "runs" },
  {
    method: "post",
    path: "/threads/:thread_id/runs/:run_id/cancel",
    handler: "cancelRun",
    group: "runs",
  },
  {
    method: "get",
    path: "/threads/:thread_id/runs/:run_id/stream",
    handler: "joinRunStream",
    group: "runs",
  },
  // The *blocking* join: `client.runs.join()` waits for the run to settle and reads its final state as
  // JSON, where `.../stream` above tails it as SSE. Two different clients want two different shapes.
  {
    method: "get",
    path: "/threads/:thread_id/runs/:run_id/join",
    handler: "joinRun",
    group: "runs",
  },
  // Before `/:run_id`, so `/deliveries` is not swallowed as a run id by a router that matches in
  // declaration order. Both sit in the `runs` group deliberately: a run is already an
  // ownership-scoped resource, so its deliveries need no group of their own — and a `RouteGroup`,
  // once shipped, is a member of a closed union that can never be withdrawn.
  {
    method: "get",
    path: "/threads/:thread_id/runs/:run_id/deliveries",
    handler: "listRunDeliveries",
    group: "runs",
  },
  {
    method: "post",
    path: "/threads/:thread_id/runs/:run_id/deliveries/:delivery_id/replay",
    handler: "replayRunDelivery",
    group: "runs",
  },
  { method: "get", path: "/threads/:thread_id/runs/:run_id", handler: "getRun", group: "runs" },
  {
    method: "delete",
    path: "/threads/:thread_id/runs/:run_id",
    handler: "deleteRun",
    group: "runs",
  },
  { method: "get", path: "/runs/:run_id/stream", handler: "joinRunStream", group: "runs" },

  // thread streaming / commands
  {
    method: "post",
    path: "/threads/:thread_id/stream",
    handler: "postThreadStream",
    group: "runs",
  },
  { method: "get", path: "/threads/:thread_id/stream", handler: "getThreadStream", group: "runs" },
  // `/stream/events` is the path the SDK's v2 agent-server transport reads from, served here as a
  // synonym for the join-stream above. Same handler, hence no new authz row.
  //
  // Only the GET. The v2 transport's POST is a *subscription* (`{ channels, ... }`, no
  // `assistant_id`) that it reopens on every reconnect, whereas `postThreadStream` **starts a run** —
  // aliasing them would turn one subscribe into up to `maxReconnectAttempts` runs on the thread.
  // Serving the GET alone does not make that transport work end to end (its POST and the protocol
  // command envelope on `/commands` are both unimplemented); it just costs nothing and is correct.
  {
    method: "get",
    path: "/threads/:thread_id/stream/events",
    handler: "getThreadStream",
    group: "runs",
  },
  {
    method: "post",
    path: "/threads/:thread_id/commands",
    handler: "postThreadCommands",
    group: "runs",
  },

  // meta — `/ok` is deliberately not here; each adapter serves it so no config flag can disable the
  // container health probe (see meta/server-info.ts).
  { method: "get", path: "/info", handler: "getServerInfo", group: "meta" },

  // store
  { method: "put", path: "/store/items", handler: "putStoreItem", group: "store" },
  { method: "get", path: "/store/items", handler: "getStoreItem", group: "store" },
  { method: "delete", path: "/store/items", handler: "deleteStoreItem", group: "store" },
  { method: "post", path: "/store/items/search", handler: "searchStoreItems", group: "store" },
  { method: "post", path: "/store/namespaces", handler: "listStoreNamespaces", group: "store" },
];

/**
 * Which route groups a server should not serve — the resolved `http.disable_*` block of a
 * `langgraph.json`. Absent/false means served, matching LangGraph's defaults.
 */
export type DisabledRouteGroups = Partial<Record<RouteGroup, boolean>>;

/**
 * Drop every route belonging to a disabled group, so a disabled resource is simply **not mounted** and
 * a request for it gets the framework's own 404 — exactly what `langgraph dev` does (it skips the
 * `app.route(...)` call rather than answering 403 or 501).
 *
 * A route with no `group` is always kept: the field is optional so tables outside the protocol (the
 * invoke surface) need not classify themselves, and "unclassified" must not mean "switchable off".
 */
export function filterSkeinRoutes(
  bindings: readonly RouteBinding[],
  disabled: DisabledRouteGroups,
): readonly RouteBinding[] {
  if (!Object.values(disabled).some(Boolean)) return bindings; // nothing disabled — same array
  return bindings.filter((binding) => binding.group === undefined || !disabled[binding.group]);
}

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
export interface RouteMatch<HandlerName = keyof ProtocolHandlers> {
  binding: RouteBinding<HandlerName>;
  params: Record<string, string>;
}

/** Matches a `method` + `pathname` against a fixed route table. Built by {@link createRouteMatcher}. */
export type RouteMatcher<HandlerName = keyof ProtocolHandlers> = (
  method: string,
  pathname: string,
) => RouteMatch<HandlerName> | undefined;

/**
 * Build a matcher over any route table — the protocol's own, or the simplified invoke surface's.
 * Each `:param` path is compiled to a named-group regex once, anchored (`^…$`) so a literal segment
 * can't be matched as a param value. The returned matcher iterates in table order, which is
 * most-specific-first, so a literal segment wins over a `:param`.
 */
export function createRouteMatcher<HandlerName>(
  bindings: readonly RouteBinding<HandlerName>[],
): RouteMatcher<HandlerName> {
  const compiled = bindings.map((binding) => ({
    binding,
    regex: new RegExp(`^${binding.path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`),
  }));
  return (method, pathname) => {
    const wanted = method.toLowerCase();
    for (const { binding, regex } of compiled) {
      if (binding.method !== wanted) continue;
      const match = regex.exec(pathname);
      if (match) return { binding, params: decodeParams(match.groups) };
    }
    return undefined;
  };
}

/**
 * Match a `method` + `pathname` (no query string) against the Agent Protocol route table. This is
 * what adapters that dispatch from a catch-all route (NestJS middleware, Next.js route handlers) use
 * in place of a framework router; Express/Fastify bind `skeinRoutes` to their native router instead.
 */
export const matchSkeinRoute: RouteMatcher = createRouteMatcher(skeinRoutes);

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
