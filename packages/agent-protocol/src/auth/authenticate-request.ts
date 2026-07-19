// Resolving the caller for one request. Shared by the protocol handler table and the single-graph
// invoke surface so both apply the *same* studio-bypass rule — a second, subtly different copy of
// this would be a way to reach a graph with credentials the other path rejects.

import type { AuthContext, AuthEngine, AuthUser } from "@skein-js/core";

import type { ProtocolRequest } from "../create-handlers.js";

import { synthesizeRequest } from "./route-authz.js";

/** The synthetic caller LangGraph Studio presents; used only when studio auth is not disabled. */
export const STUDIO_USER: AuthUser = {
  identity: "langgraph-studio-user",
  display_name: "langgraph-studio-user",
  is_authenticated: true,
  permissions: [],
};

/**
 * Authenticate a request. Studio traffic (`x-auth-scheme: langsmith`) is admitted without
 * authenticating unless `auth.disable_studio_auth` is set, matching LangGraph. Throws 401 when the
 * user's authenticate handler rejects.
 */
export async function resolveAuthContext(
  engine: AuthEngine,
  req: ProtocolRequest,
): Promise<AuthContext | undefined> {
  if (!engine.studioAuthDisabled && req.headers["x-auth-scheme"] === "langsmith") {
    return { user: STUDIO_USER, scopes: [] };
  }
  return engine.authenticate(synthesizeRequest(req));
}
