// The authentication + authorization contract, matching LangGraph's custom-auth model. Users author
// handlers against `@langchain/langgraph-sdk`'s `Auth` class exactly as on LangGraph Platform;
// `@skein-js/config` loads that instance and adapts it to the injectable `AuthEngine` below, which
// `@skein-js/agent-protocol` consults per request. The contract lives in core (with the wire types)
// so both the loader and the protocol handlers depend on one seam, never on the SDK's auth types
// directly. The SDK's `BaseUser` is internal (its public `/auth` entry exports only `Auth`,
// `HTTPException`, `isStudioUser`, `AuthFilters`), so we mirror its normalized shape here — kept
// open so adopters can attach their own fields. See docs/agent-protocol.md for the request lifecycle.

/**
 * The authenticated caller, normalized to the shape LangGraph's `Auth` produces: a required
 * `identity`, `display_name`, `is_authenticated`, and `permissions` scopes, plus open extra keys a
 * handler may attach (e.g. `email`, `org_id`). Structurally identical to the SDK's internal
 * `BaseUser`, so a graph written for LangGraph Platform reads the same `langgraph_auth_user`.
 */
export interface AuthUser {
  identity: string;
  display_name: string;
  is_authenticated: boolean;
  permissions: string[];
  [key: string]: unknown;
}

/** The result of authenticating a request: the caller plus their permission scopes. */
export interface AuthContext {
  user: AuthUser;
  scopes: string[];
}

/**
 * A protocol resource an `@auth.on.*` handler can guard. Runs authorize through their thread.
 *
 * Crons get a resource of their own rather than authorizing through a thread, because that is what
 * the SDK's `Auth` class already declares (`crons:create|read|update|delete|search`) — and because a
 * *stateless* cron has no thread to authorize through.
 */
export type AuthResource = "threads" | "assistants" | "store" | "crons";

/** An action on a resource, mirroring LangGraph's `resource:action` event names. */
export type AuthAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "search"
  | "create_run"
  | "put"
  | "get"
  | "list_namespaces";

/** A single metadata filter clause — an exact value or an `$eq`/`$contains` operator object. */
export type AuthFilterValue = string | { $eq?: string; $contains?: string | string[] };

/**
 * Ownership filters returned by an `@auth.on.*` handler. Keys are metadata fields; a returned filter
 * both scopes reads (a resource is visible only if its metadata satisfies every clause) and stamps
 * writes (the clause values are merged into new resources' metadata). Shape-compatible with
 * `@langchain/langgraph-api`'s `isAuthMatching`.
 */
export type AuthFilters = Record<string, AuthFilterValue>;

/**
 * The injectable auth engine — one per runtime, no module-global state (unlike langgraph-api's
 * `registerAuth`). Absent from `ProtocolDeps` means no auth is configured and every request is
 * allowed (the default, so `skein dev` stays frictionless).
 */
export interface AuthEngine {
  /** True when a `langgraph.json` `auth.path` was loaded; false disables the whole gate. */
  readonly enabled: boolean;
  /** When true, studio traffic must present real credentials like any other client. */
  readonly studioAuthDisabled: boolean;
  /** Run the user's authenticate handler over a request; throws 401 on rejection/missing identity. */
  authenticate(request: Request): Promise<AuthContext | undefined>;
  /** Consult the `@auth.on.*` handlers for a resource+action; throws 403 on deny, else returns filters. */
  authorize(input: {
    resource: AuthResource;
    action: AuthAction;
    value: unknown;
    context: AuthContext | undefined;
  }): Promise<{ filters?: AuthFilters; value: unknown }>;
  /** Whether a resource's metadata satisfies the ownership filters (`$eq`/`$contains` semantics). */
  matchesFilters(metadata: Record<string, unknown> | undefined, filters?: AuthFilters): boolean;
}
