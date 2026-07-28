// Loads the user's `@langchain/langgraph-sdk` `Auth` instance from a `langgraph.json` `auth.path`
// and adapts it to the injectable `AuthEngine` core contract. We deliberately do NOT use
// `@langchain/langgraph-api`'s `registerAuth`/`authenticate`/`authorize`, which keep the active auth
// in module-global state and throw hono `HTTPException` — both against skein's DI-everywhere /
// `SkeinHttpError` conventions. Instead we mirror their (small) dispatch algorithm against one
// instance and reuse only the pure `isAuthMatching` so the filter operator semantics stay identical.

import { pathToFileURL } from "node:url";

import type { AuthContext, AuthEngine, AuthFilters, AuthUser } from "@skein-js/core";
import { SkeinHttpError } from "@skein-js/core";

import { SkeinConfigError } from "./errors.js";
import { parseGraphSpec, type ModuleImporter } from "./graph-spec.js";

/** The `auth` block from a parsed `langgraph.json` (see `langgraphJsonSchema`). */
export interface AuthConfig {
  path: string;
  disable_studio_auth?: boolean;
}

/** Where and how to load the auth module — mirrors `loadGraph`'s importer seam. */
export interface LoadAuthEngineOptions {
  /** Directory the `auth.path` is resolved against (the `langgraph.json` location). */
  configDir: string;
  /** Module importer (native ESM by default; `skein dev` injects the vite-backed one). */
  importModule?: ModuleImporter;
}

/** The two callbacks skein reads off a loaded `Auth`; the SDK stores them under `~handlerCache`. */
interface AuthOnParameter {
  event: string;
  resource: string;
  action: string;
  value: unknown;
  user: AuthUser;
  permissions: string[];
}
type AuthenticateCallback = (request: Request) => unknown | Promise<unknown>;
type OnCallback = (parameter: AuthOnParameter) => unknown | Promise<unknown>;
interface AuthHandlerCache {
  authenticate?: AuthenticateCallback;
  callbacks?: Record<string, OnCallback>;
}
/** Structural view of an `Auth` instance — matches langgraph-api's own `"~handlerCache" in module` check. */
interface AuthInstance {
  "~handlerCache": AuthHandlerCache;
}

function isAuthInstance(value: unknown): value is AuthInstance {
  return typeof value === "object" && value !== null && "~handlerCache" in value;
}

/** A thrown `HTTPException` (from the SDK or a user handler) carries `status` + `headers`. */
function isHttpException(error: unknown): error is { status: number; message?: string } {
  return typeof error === "object" && error !== null && "status" in error && "headers" in error;
}

/** Convert a user handler's thrown `HTTPException` into a `SkeinHttpError`; rethrow anything else. */
function toSkeinError(error: unknown): never {
  if (isHttpException(error)) {
    throw new SkeinHttpError(error.status, error.message || "Unauthorized", { cause: error });
  }
  throw error;
}

/** Normalize an authenticate handler's return (a string or `{identity, permissions?, ...}`) to a user. */
function normalizeUser(response: unknown): AuthContext {
  if (typeof response === "string") {
    const user: AuthUser = {
      identity: response,
      display_name: response,
      is_authenticated: true,
      permissions: [],
    };
    return { user, scopes: [] };
  }
  if (
    typeof response === "object" &&
    response !== null &&
    "identity" in response &&
    typeof (response as { identity: unknown }).identity === "string"
  ) {
    const raw = response as Record<string, unknown> & { identity: string };
    const scopes = Array.isArray(raw.permissions) ? (raw.permissions as string[]) : [];
    const user: AuthUser = {
      ...raw,
      permissions: scopes,
      is_authenticated: typeof raw.is_authenticated === "boolean" ? raw.is_authenticated : true,
      display_name: typeof raw.display_name === "string" ? raw.display_name : raw.identity,
    };
    return { user, scopes };
  }
  throw new SkeinHttpError(
    500,
    "Invalid auth response — return a string identity or an object with an `identity` property.",
  );
}

/** `isAuthMatching`'s signature, so the module can be typed without importing it eagerly. */
type FilterMatcher = (
  metadata: Record<string, unknown> | undefined,
  filters?: AuthFilters,
) => boolean;

/**
 * Build an {@link AuthEngine} bound to one loaded `Auth` instance — no module-global state.
 *
 * `isAuthMatching` is passed in rather than imported at module scope. It is the only thing this package
 * uses from `@langchain/langgraph-api`, and a static import of it puts that whole package — reachable
 * from every framework adapter through the config barrel — into the module graph of a server that has no
 * auth configured at all. See `loadAuthEngine`, and `static-imports.test.ts`.
 */
function createAuthEngine(
  handlers: AuthHandlerCache,
  studioAuthDisabled: boolean,
  isAuthMatching: FilterMatcher,
): AuthEngine {
  return {
    enabled: true,
    studioAuthDisabled,

    async authenticate(request) {
      if (!handlers.authenticate) return undefined;
      try {
        return normalizeUser(await handlers.authenticate(request));
      } catch (error) {
        toSkeinError(error);
      }
    },

    async authorize({ resource, action, value, context }) {
      const callbacks = handlers.callbacks;
      // Priority mirrors langgraph-api: exact event, then resource, then action, then wildcard.
      const key = [`${resource}:${action}`, resource, `*:${action}`, "*"].find(
        (candidate) => callbacks?.[candidate],
      );
      const handler = key ? callbacks?.[key] : undefined;
      if (!handler || !context) return { filters: undefined, value };
      try {
        const result = await handler({
          event: `${resource}:${action}`,
          resource,
          action,
          value,
          user: context.user,
          permissions: context.scopes,
        });
        if (result == null || result === true) return { filters: undefined, value };
        if (result === false) throw new SkeinHttpError(403, "Forbidden.");
        if (typeof result !== "object") {
          throw new SkeinHttpError(
            500,
            `Auth handler returned an invalid result — expected a filter object, null, or a boolean, got "${typeof result}".`,
          );
        }
        return { filters: result as AuthFilters, value };
      } catch (error) {
        toSkeinError(error);
      }
    },

    matchesFilters(metadata, filters) {
      return isAuthMatching(metadata, filters);
    },
  };
}

/**
 * Load the auth engine declared by a `langgraph.json` `auth` block, or `undefined` when no `auth`
 * is configured (unauthenticated — the default). Imports the `path:export` module, validates it is
 * an `@langchain/langgraph-sdk` `Auth` instance, and adapts it to the injectable {@link AuthEngine}.
 */
export async function loadAuthEngine(
  auth: AuthConfig | undefined,
  options: LoadAuthEngineOptions,
): Promise<AuthEngine | undefined> {
  if (!auth) return undefined;

  const spec = parseGraphSpec(auth.path, options.configDir);
  const importModule =
    options.importModule ??
    ((file: string) => import(pathToFileURL(file).href) as Promise<Record<string, unknown>>);
  let module: Record<string, unknown>;
  try {
    module = await importModule(spec.sourceFile);
  } catch (cause) {
    throw new SkeinConfigError(`Failed to import auth module "${spec.sourceFile}".`, { cause });
  }

  const exported = module[spec.exportSymbol];
  if (exported == null) {
    throw new SkeinConfigError(
      `Auth module "${spec.sourceFile}" has no export "${spec.exportSymbol}".`,
    );
  }
  if (!isAuthInstance(exported)) {
    throw new SkeinConfigError(
      `Auth export "${auth.path}" is not an \`Auth\` instance from \`@langchain/langgraph-sdk/auth\`.`,
    );
  }

  // Imported here, not at module scope: this line is only reached when a `langgraph.json` declares an
  // `auth` block, so a deployment without one never loads `@langchain/langgraph-api`.
  const { isAuthMatching } = await import("@langchain/langgraph-api/auth");
  return createAuthEngine(
    exported["~handlerCache"],
    auth.disable_studio_auth ?? false,
    isAuthMatching,
  );
}
