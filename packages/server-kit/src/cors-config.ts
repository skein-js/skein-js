// Map LangGraph's `http.cors` block (declared in langgraph.json) onto `cors` middleware options, so
// an unchanged langgraph.json drives cross-origin access the same way it does under `langgraph dev`.
// skein deliberately does NOT copy LangGraph's permissive `origin: "*"` default: CORS is off until
// `http.cors` is configured (or a `cors` option is passed). See docs/langgraph-cli-compat.md.

import {
  filterSkeinRoutes,
  skeinRoutes,
  type DisabledRouteGroups,
  type RouteBinding,
  type RouteGroup,
} from "@skein-js/agent-protocol";
import type { CorsOptions } from "cors";

/** The `http.cors` block of a langgraph.json — LangGraph's field names (snake_case). */
export interface LanggraphCorsConfig {
  allow_origins?: string[];
  allow_origin_regex?: string;
  allow_methods?: string[];
  allow_headers?: string[];
  allow_credentials?: boolean;
  expose_headers?: string[];
  max_age?: number;
}

// LangGraph always exposes these two response headers; mirror that so clients read them cross-origin.
const ALWAYS_EXPOSED_HEADERS = ["content-location", "x-pagination-total"];

/** Translate a LangGraph `http.cors` config into `cors` middleware options. */
export function toCorsOptions(config: LanggraphCorsConfig): CorsOptions {
  const options: CorsOptions = {};

  // An origin is allowed if it is in `allow_origins` OR matches `allow_origin_regex` — Starlette
  // treats the two as additive, not mutually exclusive.
  const allowAll = config.allow_origins?.includes("*") ?? false;
  if (config.allow_origin_regex !== undefined) {
    // Anchor to a full-string match like Starlette's `re.fullmatch`; the non-capturing group keeps
    // top-level `a|b` alternations correct. A bare `.test()` matches substrings, so an unanchored
    // `https://.*\.trusted\.com` would wrongly allow `https://x.trusted.com.attacker.io`.
    const pattern = new RegExp(`^(?:${config.allow_origin_regex})$`);
    const listed = allowAll ? undefined : new Set(config.allow_origins);
    options.origin = (origin, callback) =>
      callback(
        null,
        origin !== undefined &&
          (allowAll || pattern.test(origin) || (listed?.has(origin) ?? false)),
      );
  } else if (config.allow_origins !== undefined) {
    // A configured `["*"]` is LangGraph's allow-all; otherwise restrict to the listed origins.
    options.origin = allowAll ? "*" : config.allow_origins;
  }

  if (config.allow_methods !== undefined) options.methods = config.allow_methods;
  if (config.allow_headers !== undefined) options.allowedHeaders = config.allow_headers;
  if (config.allow_credentials !== undefined) options.credentials = config.allow_credentials;
  if (config.max_age !== undefined) options.maxAge = config.max_age;

  const exposed = new Set([...ALWAYS_EXPOSED_HEADERS, ...(config.expose_headers ?? [])]);
  options.exposedHeaders = [...exposed];

  return options;
}

/** Read `http.cors` from a langgraph.json `http` block, mapped to `CorsOptions`, or `undefined`. */
export function corsFromHttpConfig(http: unknown): CorsOptions | undefined {
  if (typeof http !== "object" || http === null) return undefined;
  const cors = (http as { cors?: unknown }).cors;
  if (typeof cors !== "object" || cors === null) return undefined;
  return toCorsOptions(cors as LanggraphCorsConfig);
}

/** The `http.disable_*` flag that switches off each route group. */
const DISABLE_FLAGS: Record<string, RouteGroup> = {
  disable_assistants: "assistants",
  disable_threads: "threads",
  disable_runs: "runs",
  disable_store: "store",
  disable_meta: "meta",
};

/**
 * Read the `http.disable_*` route toggles from a langgraph.json `http` block.
 *
 * Only literal `true` disables a group: LangGraph's schema defaults each flag to `false`, and a
 * truthy-but-not-true value (a `"false"` string from an env-substituted config) must not silently
 * remove a resource.
 */
export function disabledRoutesFromHttpConfig(http: unknown): DisabledRouteGroups {
  if (typeof http !== "object" || http === null) return {};
  const flags = http as Record<string, unknown>;
  const disabled: DisabledRouteGroups = {};
  for (const [flag, group] of Object.entries(DISABLE_FLAGS)) {
    if (flags[flag] === true) disabled[group] = true;
  }
  return disabled;
}

/**
 * The route table a server should mount given a langgraph.json `http` block — the full table when
 * nothing is disabled (the same array, not a copy).
 */
export function routesFromHttpConfig(http: unknown): readonly RouteBinding[] {
  return filterSkeinRoutes(skeinRoutes, disabledRoutesFromHttpConfig(http));
}
