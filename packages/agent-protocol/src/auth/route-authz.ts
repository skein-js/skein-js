// Maps each protocol handler to the resource + action an `@auth.on.*` handler guards, mirroring
// LangGraph's `resource:action` event names. Runs have no resource of their own — every run
// operation authorizes through its owning thread (`threads:read`/`update`/`delete`/`create_run`),
// exactly as LangGraph does. Also builds the WHATWG `Request` the user's authenticate handler reads.

import type { AuthAction, AuthResource } from "@skein-js/core";

import type { ProtocolHandlers, ProtocolRequest } from "../create-handlers.js";

/** The resource + action a route authorizes against. */
export interface RouteAuthz {
  resource: AuthResource;
  action: AuthAction;
  /**
   * A second resource to authorize against when {@link resource} produced no ownership filters —
   * used to inherit scoping rather than fall open.
   *
   * This exists because `@auth.on.*` callbacks are matched by **exact event key**
   * (`resource:action` → `resource` → `*:action` → `*`), so a deployment that registered
   * `.on("threads", …)` has no callback for a resource named anything else, and `authorize` answers
   * "no filters" — which the dispatcher reads as "nothing to scope", not as "deny".
   *
   * For `assistants` and `store` that is the documented gate-only behaviour and is harmless: neither
   * can write into another tenant's data. `crons` is the first resource for which it is *not* — a
   * schedule creates runs on a thread, so an unscoped cron resource would let any authenticated
   * caller enumerate every tenant's schedules and attach one to a thread they cannot even read.
   *
   * So crons fall back to `threads`, which is also the honest description of what they are: runs,
   * scheduled. A deployment that does register `@auth.on.crons` keeps full control and never reaches
   * the fallback.
   */
  fallbackResource?: AuthResource;
  /** The action to authorize against {@link fallbackResource}; defaults to {@link action}. */
  fallbackAction?: AuthAction;
}

/** Every handler's resource + action. Keyed by handler name so it stays in lockstep with the table. */
export const ROUTE_AUTHZ: Record<keyof ProtocolHandlers, RouteAuthz> = {
  // assistants
  getAssistant: { resource: "assistants", action: "read" },
  getAssistantSchemas: { resource: "assistants", action: "read" },
  getAssistantGraph: { resource: "assistants", action: "read" },
  getAssistantSubgraphs: { resource: "assistants", action: "read" },
  listAssistantVersions: { resource: "assistants", action: "read" },
  searchAssistants: { resource: "assistants", action: "search" },
  countAssistants: { resource: "assistants", action: "search" },
  createAssistant: { resource: "assistants", action: "create" },
  updateAssistant: { resource: "assistants", action: "update" },
  setAssistantLatestVersion: { resource: "assistants", action: "update" },
  deleteAssistant: { resource: "assistants", action: "delete" },

  // threads
  createThread: { resource: "threads", action: "create" },
  copyThread: { resource: "threads", action: "create" },
  getThread: { resource: "threads", action: "read" },
  getThreadState: { resource: "threads", action: "read" },
  getThreadStateAtCheckpoint: { resource: "threads", action: "read" },
  getThreadStateAtCheckpointFromBody: { resource: "threads", action: "read" },
  getThreadHistory: { resource: "threads", action: "read" },
  listThreads: { resource: "threads", action: "search" },
  countThreads: { resource: "threads", action: "search" },
  // A prune *removes* threads (or their history), so it authorizes as a delete rather than as the
  // search that selects them.
  pruneThreads: { resource: "threads", action: "delete" },
  patchThread: { resource: "threads", action: "update" },
  // Time-travel state update forks a checkpoint — a write, so read-only principals can't fork.
  updateThreadState: { resource: "threads", action: "update" },
  deleteThread: { resource: "threads", action: "delete" },

  // runs (authorized through the owning thread)
  createWaitRun: { resource: "threads", action: "create_run" },
  createStreamRun: { resource: "threads", action: "create_run" },
  createBackgroundRun: { resource: "threads", action: "create_run" },
  createStatelessRun: { resource: "threads", action: "create_run" },
  createRunBatch: { resource: "threads", action: "create_run" },
  getRun: { resource: "threads", action: "read" },
  listThreadRuns: { resource: "threads", action: "read" },
  joinRunStream: { resource: "threads", action: "read" },
  joinRun: { resource: "threads", action: "read" },
  cancelRun: { resource: "threads", action: "update" },
  // Like `cancelRun` — and each run it sweeps is re-checked against the ownership filter by the
  // scoped store's `get`, so a broad sweep cannot reach another owner's runs.
  cancelManyRuns: { resource: "threads", action: "update" },
  deleteRun: { resource: "threads", action: "delete" },

  // crons — the one resource besides threads/assistants/store with `@auth.on` events of its own,
  // because the SDK's `Auth` class already declares them (`crons:create|read|update|delete|search`)
  // and because a *stateless* cron has no thread to authorize through.
  //
  // Every one falls back to `threads` when no cron handler is registered — see
  // `RouteAuthz.fallbackResource`. Without that, a deployment scoping only threads (the idiomatic
  // pattern, and what this repo's own chat-app example does) would serve the entire crons resource
  // unscoped.
  createCron: {
    resource: "crons",
    action: "create",
    fallbackResource: "threads",
    // Creating a schedule is asking for runs on a thread, so it inherits the permission that
    // governs exactly that — not `threads:create`.
    fallbackAction: "create_run",
  },
  getCron: { resource: "crons", action: "read", fallbackResource: "threads" },
  searchCrons: { resource: "crons", action: "search", fallbackResource: "threads" },
  countCrons: { resource: "crons", action: "search", fallbackResource: "threads" },
  updateCron: { resource: "crons", action: "update", fallbackResource: "threads" },
  deleteCron: { resource: "crons", action: "delete", fallbackResource: "threads" },

  // thread streaming / commands
  postThreadStream: { resource: "threads", action: "create_run" },
  getThreadStream: { resource: "threads", action: "read" },
  postThreadCommands: { resource: "threads", action: "create_run" },

  // meta — the capability handshake. `createAuthorizingHandlers` serves this one **unauthenticated**,
  // matching `@langchain/langgraph-api` (whose auth middleware skips `/info` explicitly): clients probe
  // it before they have credentials. The entry is kept so this table stays exhaustive over the handler
  // table, and names the resource:action that *would* apply if that exemption were ever removed.
  getServerInfo: { resource: "assistants", action: "read" },

  // store
  putStoreItem: { resource: "store", action: "put" },
  getStoreItem: { resource: "store", action: "get" },
  deleteStoreItem: { resource: "store", action: "delete" },
  searchStoreItems: { resource: "store", action: "search" },
  listStoreNamespaces: { resource: "store", action: "list_namespaces" },
};

/** The payload passed to an `@auth.on.*` handler — the request's identifiers merged with its body. */
export function authValue(req: ProtocolRequest): Record<string, unknown> {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  return { ...req.query, ...req.params, ...body };
}

/**
 * Headers that describe the ORIGINAL transport framing, not the payload. We re-serialize the body
 * below, so the incoming `content-length` (and any transfer framing) would no longer match — copying
 * them can make a strict runtime reject or mis-read the synthesized `Request`. Everything else
 * (`authorization`, `x-api-key`, `cookie`, `content-type`, …) is forwarded so the auth handler sees it.
 */
const FRAMING_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);

/**
 * Rebuild a WHATWG `Request` from a `ProtocolRequest` so the user's authenticate handler sees the
 * method, URL, and headers (where a bearer token / API key lives). A JSON body is attached for
 * methods that carry one, so a handler that reads `await request.json()` still works; GET/HEAD
 * cannot carry a body per the `Request` contract. Note the URL host comes from the client `Host`
 * header — an auth handler must not derive trust from it.
 */
export function synthesizeRequest(req: ProtocolRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !FRAMING_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  const method = req.method.toUpperCase();
  const carriesBody = method !== "GET" && method !== "HEAD" && req.body !== undefined;
  return new Request(req.url, {
    method,
    headers,
    body: carriesBody ? JSON.stringify(req.body) : undefined,
  });
}
