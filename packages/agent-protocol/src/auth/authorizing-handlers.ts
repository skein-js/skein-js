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
import { authValue, ROUTE_AUTHZ } from "./route-authz.js";

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
    const route = ROUTE_AUTHZ[name];
    wrapped[name] = async (req) => {
      const authContext: AuthContext | undefined = await resolveAuthContext(engine, req);
      const { filters } = await engine.authorize({
        resource: route.resource,
        action: route.action,
        value: authValue(req),
        context: authContext,
      });
      // Fast path: nothing request-specific to inject — reuse the shared, once-built handler table.
      if (!filters && !authContext) return baseHandlers[name](req);

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
      return createProtocolHandlers(createProtocolServiceFromContext(requestContext))[name](req);
    };
  }
  return wrapped;
}
