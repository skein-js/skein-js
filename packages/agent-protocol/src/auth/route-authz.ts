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
   * For `assistants` and `store` that is the documented gate-only behaviour, and it is **not** benign
   * for the store: an authenticated caller with no `@auth.on.store` handler reads and writes every
   * namespace. It is deliberate nonetheless — a store item carries no metadata for an inherited filter
   * to match, so the only thing a fallback could do here is hand a thread handler a store-shaped
   * payload it never agreed to validate. Scoping the store is the deployment's own `@auth.on.store`
   * handler, which can *rewrite* the namespace (see {@link rewrittenStoreTarget}); that is both what
   * LangGraph documents and strictly more expressive than an inherited filter. `crons` is the resource
   * for which gate-only is not just unscoped but unsafe in a way a fallback *can* fix — a schedule
   * creates runs on a thread, so an unscoped cron resource would let any authenticated caller enumerate
   * every tenant's schedules and attach one to a thread they cannot even read.
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
  // channels — an inbound event creates a run on a thread, so it authorizes exactly as every other
  // run-creating route does. The crons precedent: the principal comes from somewhere other than a
  // bearer token, but what it is allowed to do is the same question.
  //
  // **This row is read by the pipeline rather than applied by `createAuthorizingHandlers`.** The
  // channel route authenticates through the channel's `verify()`, which runs over the raw request
  // before anything is parsed, so it cannot go through `resolveAuthContext` — see the note in
  // `authorizing-handlers.ts`. The entry stays here so there is one source of truth for the pair, and
  // so this record remains exhaustive over the handler table.
  handleInboundEvent: { resource: "threads", action: "create_run" },
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
  // `threads`, not a resource of their own: both handlers read the run first, so the existing
  // ownership filter 404s a non-owner before any delivery is touched. A replay changes what the
  // server will do, so it is an `update` rather than a `read`.
  listRunDeliveries: { resource: "threads", action: "read" },
  replayRunDelivery: { resource: "threads", action: "update" },
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

/**
 * The request-body fields each store route reads its target from — the inverse of
 * {@link storeNamespace}, and the reason a rewrite can be written back at all.
 *
 * `key` is absent on the two search routes because they address no single item; a handler that assigns
 * `value.key` there is asking for something the endpoint has nowhere to put, which
 * {@link rewrittenStoreTarget} refuses rather than dropping.
 */
const STORE_TARGET_FIELDS: Partial<
  Record<keyof ProtocolHandlers, { namespace: string; key?: string }>
> = {
  putStoreItem: { namespace: "namespace", key: "key" },
  getStoreItem: { namespace: "namespace", key: "key" },
  deleteStoreItem: { namespace: "namespace", key: "key" },
  searchStoreItems: { namespace: "namespace_prefix" },
  listStoreNamespaces: { namespace: "prefix" },
};

/** Two namespace paths are the same path. */
function sameNamespace(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/** The item a store route addresses, as an `@auth.on.store` handler redirected it. */
export interface StoreTargetRewrite {
  namespace?: string[];
  key?: string;
}

/**
 * `req` with its store target replaced by `rewrite` — the LangGraph Platform idiom, where an
 * `@auth.on.store` handler **rewrites** what the caller addressed to scope them, rather than returning a
 * filter.
 *
 * Written into the *body* fields the endpoint reads, whatever the caller used: `storeItemTarget` prefers a
 * body namespace over the query, so a `GET /store/items?namespace=…` is rewritten by adding one. It reads
 * namespace and key independently, so rewriting one leaves the other's source alone. The rest of the body
 * is preserved, so the item `value` survives.
 *
 * Trusted by construction: the mutation comes from the deployment's own auth module, which is the code
 * whose job is deciding what this caller may address.
 */
export function withStoreTarget(
  req: ProtocolRequest,
  handler: keyof ProtocolHandlers,
  rewrite: StoreTargetRewrite,
): ProtocolRequest {
  const fields = STORE_TARGET_FIELDS[handler];
  if (!fields) return req;
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const rewritten: Record<string, unknown> = { ...body };
  if (rewrite.namespace) rewritten[fields.namespace] = rewrite.namespace;
  if (rewrite.key !== undefined && fields.key) rewritten[fields.key] = rewrite.key;
  return { ...req, body: rewritten };
}

/**
 * How an `@auth.on.store` handler redirected the request, or `undefined` if it left it alone.
 *
 * LangGraph documents store authorization as *mutating* `value` rather than returning ownership filters —
 * the store is the one resource whose scoping is namespace-shaped, so a metadata filter has nothing to
 * match on. skein's engine hands the handler the same `value` object it returns, so a mutation is visible
 * here; before this it was silently discarded, and a ported handler scoped nothing while looking like it
 * did. Both fields the server derives are honoured, `namespace` and `key`, because dropping either is the
 * same failure one field over.
 *
 * A rewrite that is not the right *shape* throws rather than falling through to the caller's own target: a
 * handler that meant to scope and got the shape wrong must not end up scoping nothing.
 *
 * **A rewrite is only read off the object skein handed in (`returned === handed`), and that guard is
 * load-bearing twice over.** The interface types `authorize`'s reply as `{ filters?, value: unknown }` and
 * promises nothing about *which* object comes back — skein's own engine echoes the one it was given, but an
 * embedder implementing `AuthEngine` themselves may return a fresh object, or a defensive copy, or the
 * filters. Without the guard:
 *
 * 1. A reply carrying no `namespace` reads as "the handler deleted it", which 500-ed every `/store/*`
 *    request on a deployment that never rewrote anything.
 * 2. Worse, a reply that is a *copy of the raw request body* reintroduces the decoy bypass `authValue`
 *    exists to close: the store schemas are `.passthrough()`, so a caller can put a `namespace` on a
 *    `search` request, and reading it back off a body copy would redirect `namespace_prefix` to a namespace
 *    the **caller** chose while the handler was shown the one the server derived.
 *
 * So a reply that is not the object we handed in carries no observable rewrite — exactly the behaviour
 * before rewrites were honoured at all, and never worse than it.
 */
export function rewrittenStoreTarget(input: {
  handler: keyof ProtocolHandlers;
  /** The `value` object handed to `authorize` — the identity a rewrite has to be visible through. */
  handed: Record<string, unknown>;
  /** `authorize`'s reply `value`; the same object as `handed` for skein's own engine. */
  returned: unknown;
  /**
   * The server's own reading, snapshotted *before* the handler ran. The namespace is compared by value
   * because an in-place `value.namespace[0] = …` mutates the very array we would otherwise compare with;
   * `key` stays `unknown` because on the search routes it is whatever the caller's passthrough body
   * carried, and a caller must not be able to provoke the shape refusal below.
   */
  before: { namespace: string[] | undefined; key: unknown };
}): StoreTargetRewrite | undefined {
  const { handler, handed, returned, before } = input;
  if (returned !== handed) return undefined;

  const namespace = rewrittenNamespaceField(handed["namespace"], before.namespace);
  const key = rewrittenKeyField(
    handed["key"],
    before.key,
    STORE_TARGET_FIELDS[handler]?.key !== undefined,
  );
  if (!namespace && key === undefined) return undefined;
  return { ...(namespace ? { namespace } : {}), ...(key !== undefined ? { key } : {}) };
}

/** The rewritten namespace, or `undefined` when untouched; throws on a shape the endpoint cannot use. */
function rewrittenNamespaceField(
  after: unknown,
  before: string[] | undefined,
): string[] | undefined {
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

/**
 * The rewritten key, or `undefined` when untouched. Only ever called for the object skein handed the
 * handler, so any difference from `before` is a mutation this server can attribute to it.
 *
 * `addressable` is false on the two search routes, which name no single item. A handler assigning a key
 * there is refused rather than ignored: there is no field for it to land in, so honouring it is impossible
 * and dropping it silently is the exact failure this function exists to prevent.
 */
function rewrittenKeyField(
  after: unknown,
  before: unknown,
  addressable: boolean,
): string | undefined {
  if (after === before) return undefined;
  if (!addressable) {
    throw new SkeinHttpError(
      500,
      `An \`@auth.on.store\` handler rewrote \`value.key\` on a route that addresses no single item ` +
        `(\`store:search\` / \`store:list_namespaces\`), so there is nothing to redirect. Scope those ` +
        `actions with \`value.namespace\` instead.`,
      { code: "store_key_rewrite_invalid" },
    );
  }
  if (typeof after === "string") return after;
  throw new SkeinHttpError(
    500,
    `An \`@auth.on.store\` handler rewrote \`value.key\` to something that is not a string (got ` +
      `${after === undefined ? "undefined" : typeof after}). Assign a \`string\` to redirect which item ` +
      `the caller addresses, or leave \`value.key\` alone.`,
    { code: "store_key_rewrite_invalid" },
  );
}
