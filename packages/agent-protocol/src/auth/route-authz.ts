// Maps each protocol handler to the resource + action an `@auth.on.*` handler guards, mirroring
// LangGraph's `resource:action` event names. Runs have no resource of their own — every run
// operation authorizes through its owning thread (`threads:read`/`update`/`delete`/`create_run`),
// exactly as LangGraph does. Also builds the WHATWG `Request` the user's authenticate handler reads.

import { SkeinHttpError, type AuthAction, type AuthResource } from "@skein-js/core";

import { storeItemTarget } from "../create-handlers.js";
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
   * scheduled.
   *
   * The limit worth knowing: `authorize` answers `{ filters: undefined }` for *three* different
   * cases — no handler matched, the handler returned `null`, and the handler returned `true` — and
   * they are indistinguishable from here. A deployment that registers `@auth.on.crons` returning
   * `true` to mean "allow, unscoped" therefore still reaches this fallback and gets thread scoping.
   * Returning an explicit filter object (or `false`) is unambiguous and is not affected. Erring
   * toward the narrower scope is the right direction for a resource that writes into threads, but
   * it is a real constraint rather than a free win.
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

  // store. Deliberately **no** `fallbackResource`, unlike crons: falling back to `threads` would hand a
  // thread handler a store-shaped payload it never agreed to validate, and there is nothing for inherited
  // filters to do here anyway — store items carry no metadata, so `createAuthScopedStore` leaves the store
  // repo alone. A deployment scopes its store in an `@auth.on.store` handler, which is where the policy
  // belongs. `@langchain/langgraph-api` has no fallback here either.
  putStoreItem: { resource: "store", action: "put" },
  getStoreItem: { resource: "store", action: "get" },
  deleteStoreItem: { resource: "store", action: "delete" },
  searchStoreItems: { resource: "store", action: "search" },
  listStoreNamespaces: { resource: "store", action: "list_namespaces" },
};

/** `value` if it is an array of strings, else `undefined` — a malformed path must not read as a path. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((segment) => typeof segment === "string") ? (value as string[]) : undefined;
}

/**
 * The namespace a store route will actually operate on, or `undefined` for any other route.
 *
 * Wrapped in an object so "a store route naming no namespace" (`{ path: undefined }`) is distinguishable
 * from "not a store route at all" (`undefined`). The distinction matters: on the two search routes an
 * absent path means *every* namespace, which is precisely the request a scoping handler has to refuse.
 *
 * Parsed the same way the handler parses it — `namespaceFromQuery` for the query routes, the same field
 * the handler reads for the body routes. That agreement is the whole point; two spellings of "which
 * namespace is this" is what let an authorized field diverge from the used one.
 */
function storeNamespace(
  handler: keyof ProtocolHandlers,
  req: ProtocolRequest,
  body: Record<string, unknown>,
): { path: string[] | undefined; key?: string } | undefined {
  // Gated on the *resource*, not on the switch below, so a store route added later without a case here
  // gets `{ path: undefined }` — fail closed — instead of falling through to the caller's own body
  // `namespace`, which is precisely the decoy bypass this function exists to close. Nothing in the type
  // system would force a new case, so the default must not be the permissive branch.
  if (ROUTE_AUTHZ[handler].resource !== "store") return undefined;
  switch (handler) {
    case "putStoreItem":
      return { path: stringArray(body["namespace"]), key: stringOrUndefined(body["key"]) };
    case "getStoreItem":
    case "deleteStoreItem": {
      // Body-or-query, via the same helper the handler uses — `deleteItem` sends a body, `getItem` a
      // query string, and authorizing the wrong one is a bypass rather than a mismatch. `key` comes from
      // the same read for the same reason: it selects the item, so authorizing a different one is the
      // same class of bug as authorizing a different namespace.
      const target = storeItemTarget(req);
      return { path: target.namespace, key: target.key };
    }
    case "searchStoreItems":
      return { path: stringArray(body["namespace_prefix"]) };
    case "listStoreNamespaces":
      return { path: stringArray(body["prefix"]) };
    default:
      return { path: undefined };
  }
}

/** `value` when it is a string, else `undefined` — so a non-string `key` never reads as one. */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The payload passed to an `@auth.on.*` handler — the request's identifiers merged with its body.
 *
 * **Store routes get their `namespace` normalized, and the normalization is server-owned.** Two reasons,
 * both of which made a hand-written scoping handler wrong before:
 *
 * 1. **Parity.** `@langchain/langgraph-sdk/auth` declares `namespace: string[]` for every store action
 *    — including `store:search` and `store:list_namespaces`, where skein's *wire* fields are
 *    `namespace_prefix` and `prefix`. A handler written against those published types read `undefined`
 *    and either allowed every cross-tenant search or refused every legitimate one. On the query routes
 *    the wire form is a dot-joined string where the SDK declares an array, so `namespace.join(".")`
 *    threw inside authorize.
 * 2. **Soundness.** Both store body schemas are `.passthrough()`, so the raw body reached a handler with
 *    whatever extra fields the caller invented. A handler checking `value.namespace` could be satisfied
 *    by a decoy `namespace` on a search request that the endpoint then serves from `namespace_prefix` —
 *    authorizing one field and using another. Assigning `namespace` **after** the body spread makes the
 *    server's reading authoritative, so a decoy is simply overwritten.
 *
 * The raw wire fields are left in place beside it; only `namespace` and `key` are guaranteed to be what
 * the endpoint uses.
 *
 * **`req.params` is spread last, and that ordering is load-bearing.** A path param names the resource
 * the handler will actually operate on — every handler reads it via `requireParam(req.params, …)`. With
 * the body spread last, a `POST /threads/{victim}/runs` carrying `{"thread_id": "attacker-owned"}`
 * authorized the *attacker's* thread while the run executed on the victim's, because the schemas are
 * `.passthrough()` and the body won. A deployment whose `@auth.on.threads` handler returns ownership
 * filters was still protected by the scoped store, but a check-only handler — one that inspects `value`
 * and returns nothing — had authorization pointed at the wrong resource entirely. Same shape as the
 * store `namespace` decoy, and the same fix: the server's reading wins.
 */
export function authValue(
  req: ProtocolRequest,
  handler?: keyof ProtocolHandlers,
): Record<string, unknown> {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const merged: Record<string, unknown> = { ...req.query, ...body, ...req.params };
  const target = handler
    ? storeNamespace(handler, req, body as Record<string, unknown>)
    : undefined;
  if (target) {
    merged["namespace"] = target.path;
    if ("key" in target) merged["key"] = target.key;
  }
  return merged;
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

/** The request-body field each store route reads its namespace from. */
const STORE_NAMESPACE_FIELD: Partial<Record<keyof ProtocolHandlers, string>> = {
  putStoreItem: "namespace",
  getStoreItem: "namespace",
  deleteStoreItem: "namespace",
  searchStoreItems: "namespace_prefix",
  listStoreNamespaces: "prefix",
};

/** Two namespace paths are the same path. */
function sameNamespace(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/**
 * `req` with its store namespace replaced by `namespace` — the LangGraph Platform idiom, where an
 * `@auth.on.store` handler **rewrites** the namespace to scope a caller rather than returning a filter.
 *
 * Written into the *body* field the endpoint reads, whatever the caller used: `storeItemTarget` prefers a
 * body namespace over the query, so a `GET /store/items?namespace=…` is rewritten by adding one. The
 * original body is preserved around it, so `key` and the item `value` survive.
 *
 * Trusted by construction: the mutation comes from the deployment's own auth module, which is the code
 * whose job is deciding what this caller may address.
 */
export function withStoreNamespace(
  req: ProtocolRequest,
  handler: keyof ProtocolHandlers,
  namespace: string[],
): ProtocolRequest {
  const field = STORE_NAMESPACE_FIELD[handler];
  if (!field) return req;
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  return { ...req, body: { ...body, [field]: namespace } };
}

/**
 * The namespace an `@auth.on.store` handler rewrote, or `undefined` if it left it alone.
 *
 * LangGraph documents store authorization as *mutating* `value.namespace` rather than returning ownership
 * filters — the store is the one resource whose scoping is namespace-shaped, so a metadata filter has
 * nothing to match on. skein's engine hands the handler the same `value` object it returns, so a mutation
 * is visible here; before this it was silently discarded, and a ported handler scoped nothing while
 * looking like it did.
 *
 * A rewrite that is not a `string[]` throws rather than falling through to the caller's own namespace: a
 * handler that meant to scope and got the shape wrong must not end up scoping nothing.
 */
export function rewrittenStoreNamespace(
  value: unknown,
  before: readonly string[] | undefined,
): string[] | undefined {
  // `AuthEngine.authorize` types its returned value as `unknown` — it is whatever the handler was handed
  // and may have mutated, so nothing stronger is honest.
  if (typeof value !== "object" || value === null) return undefined;
  const after = (value as Record<string, unknown>)["namespace"];
  if (Array.isArray(after) && after.every((segment) => typeof segment === "string")) {
    return sameNamespace(after as string[], before) ? undefined : (after as string[]);
  }
  if (after === before) return undefined;
  throw new SkeinHttpError(
    500,
    `An \`@auth.on.store\` handler rewrote \`value.namespace\` to something that is not an array of ` +
      `strings (got ${after === undefined ? "undefined" : typeof after}). Assign a \`string[]\` to scope ` +
      `the caller — e.g. \`value.namespace = [user.identity, ...value.namespace.slice(1)]\`.`,
    { code: "store_namespace_rewrite_invalid" },
  );
}
