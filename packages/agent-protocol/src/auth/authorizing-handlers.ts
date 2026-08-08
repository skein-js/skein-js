// Wraps the protocol handler table with authentication + authorization when an `AuthEngine` is
// configured. This is the ONE transport-neutral seam through which every adapter (Express, Fastify,
// Nest) inherits auth — nothing framework-specific lives here. Per request it authenticates the
// caller (studio traffic bypassed unless disabled), authorizes the route's resource + action, and —
// only when the handler returned ownership filters — dispatches through a per-request service whose
// store is the auth-scoped decorator. The shared cancellation registry and thread locks are reused
// from the base context (only `deps.store` is swapped), so background-run cancellation still works.

import type { AuthContext, AuthEngine } from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import { createProtocolHandlers, type ProtocolHandlers } from "../create-handlers.js";
import { createProtocolServiceFromContext } from "../service.js";

import { createAuthScopedStore } from "./auth-scoped-store.js";
import { resolveAuthContext } from "./authenticate-request.js";
import {
  authValue,
  rewrittenStoreNamespace,
  ROUTE_AUTHZ,
  withStoreNamespace,
} from "./route-authz.js";

/**
 * Build a handler table that authenticates and authorizes every request before dispatch. Studio
 * traffic (`x-auth-scheme: langsmith`) is admitted without authenticating unless
 * `auth.disable_studio_auth` is set, matching LangGraph.
 */
export function createAuthorizingHandlers(
  context: ProtocolContext,
  engine: AuthEngine,
): ProtocolHandlers {
  // The shared, unscoped handler table — built once and reused on the fast path (no principal, no
  // ownership filters), so a request with nothing to inject skips rebuilding the service.
  const baseHandlers = createProtocolHandlers(createProtocolServiceFromContext(context));
  const names = Object.keys(ROUTE_AUTHZ) as (keyof ProtocolHandlers)[];

  const wrapped = {} as ProtocolHandlers;
  for (const name of names) {
    // `GET /info` is served unauthenticated, matching `@langchain/langgraph-api`, whose auth middleware
    // opens with an explicit `if (c.req.path === "/info") return next()`. It is a *capability
    // handshake*: Studio and monitoring clients probe it before they have credentials, so 401-ing it
    // would break connecting to an auth-enabled skein server that `langgraph dev` would have answered.
    // It exposes no thread, run, or store content — only versions and which resources are served.
    if (name === "getServerInfo") {
      wrapped[name] = baseHandlers[name];
      continue;
    }
    const route = ROUTE_AUTHZ[name];
    wrapped[name] = async (req) => {
      const authContext: AuthContext | undefined = await resolveAuthContext(engine, req);
      // The handler name is passed so store routes get their `namespace` normalized to the shape the
      // SDK declares, server-derived rather than taken from the body — see `authValue`.
      const value = authValue(req, name);
      // A **copy**, captured before the handler runs, so a rewrite can be told from the server's own
      // reading. Aliasing the array instead made an *in-place* rewrite (`value.namespace[0] = identity`)
      // invisible — and worse, inconsistently so: for `put`/`search` the array is the body's own, so the
      // mutation took effect anyway, while for `get`/`delete` it is a fresh array parsed from the query and
      // the rewrite silently did nothing. Scoping that works on three routes and fails on two is the worst
      // of the available outcomes.
      const namespaceValue = value["namespace"];
      const derivedNamespace = Array.isArray(namespaceValue)
        ? [...(namespaceValue as string[])]
        : undefined;
      const primary = await engine.authorize({
        resource: route.resource,
        action: route.action,
        value,
        context: authContext,
      });

      // LangGraph documents store authorization as *rewriting* `value.namespace` rather than returning
      // ownership filters — the store is the one resource whose scoping is namespace-shaped, so a metadata
      // filter has nothing to match on. The engine hands the handler the same `value` object it returns, so
      // a mutation is visible; honoured here rather than discarded, which is what a ported LangGraph auth
      // module expects and what previously scoped nothing while looking like it did.
      //
      // Only the route's *own* resource is consulted: the `threads` fallback below exists to inherit
      // ownership filters, and a thread handler has no business redirecting a store namespace.
      //
      // **Read before the fallback runs, and that ordering is load-bearing.** Both `authorize` calls are
      // handed the *same* `value` object, so a fallback handler's mutation would otherwise be picked up
      // here too — turning the fallback into a namespace-rewrite channel for handlers that never opted
      // into being one. Moving the fallback above this line would reintroduce that.
      const scopedRequest =
        route.resource === "store"
          ? (() => {
              const rewritten = rewrittenStoreNamespace(primary.value, derivedNamespace);
              return rewritten ? withStoreNamespace(req, name, rewritten) : req;
            })()
          : req;

      // No filters from the primary resource means one of two things the engine cannot tell apart:
      // the caller's handler allowed this outright, or *there is no handler for this resource at
      // all* (callbacks are matched by exact event key, so `.on("threads", …)` matches nothing named
      // `crons`). Falling open is right for a gate-only resource and wrong for one that can write
      // into another tenant's thread, so a route may nominate a resource to inherit scoping from.
      //
      // Whichever handler produced the filters, they are applied under the **route's own** resource
      // (`route.resource` at the call site below), not the fallback's. That is what a crons route
      // needs: the crons branch of `createAuthScopedStore` knows how to filter cron-shaped reads,
      // and the filters it applies are simply the caller's thread ownership.
      const fallback =
        !primary.filters && route.fallbackResource
          ? await engine.authorize({
              resource: route.fallbackResource,
              action: route.fallbackAction ?? route.action,
              value,
              context: authContext,
            })
          : undefined;
      const filters = primary.filters ?? fallback?.filters;

      // Fast path: nothing request-specific to inject — reuse the shared, once-built handler table.
      if (!filters && !authContext) return baseHandlers[name](scopedRequest);

      // Otherwise dispatch through a per-request context carrying the authenticated caller (so the run
      // service stamps it onto the run → `configurable.langgraph_auth_user`) and, when the handler
      // returned ownership filters, the auth-scoped store. The shared cancellation registry and thread
      // locks are inherited so background-run cancellation still works.

      const requestContext: ProtocolContext = {
        ...context,
        authUser: authContext?.user,
        authScopes: authContext?.scopes,
        deps: filters
          ? {
              ...context.deps,
              store: createAuthScopedStore(context.deps.store, engine, filters, route.resource),
            }
          : context.deps,
      };
      return createProtocolHandlers(createProtocolServiceFromContext(requestContext))[name](
        scopedRequest,
      );
    };
  }
  return wrapped;
}
