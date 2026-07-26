// The `langgraph.json` contract, exactly as the LangGraph CLI defines it — skein-js reads an
// existing file unchanged (docs/langgraph-cli-compat.md). We validate only the fields we act
// on and pass everything else through, so a config with newer/unknown keys still loads and a
// round-trip preserves it. Zod gives us a typed value plus a precise error at the boundary.

import { z } from "zod";

import { SkeinConfigError } from "./errors.js";

/** `store.index` — drives pgvector semantic search on the Postgres driver. */
const storeIndexSchema = z
  .object({
    embed: z.string().optional(),
    dims: z.number().optional(),
    fields: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * `store.ttl` — expiry policy for long-term store items, matching LangGraph's store TTL config.
 * `default_ttl` and `refresh_on_read` shape how items expire; `sweep_interval_minutes` sets how
 * often the background sweeper deletes expired rows. All durations are in minutes.
 */
const storeTtlSchema = z
  .object({
    /** Default item lifetime in minutes when a `put` doesn't specify its own `ttl`. */
    default_ttl: z.number().optional(),
    /** Extend an item's expiry when it is read (default true). */
    refresh_on_read: z.boolean().optional(),
    /** How often the background sweeper runs, in minutes (default 60). */
    sweep_interval_minutes: z.number().optional(),
  })
  .passthrough();

/**
 * One telemetry provider: `true` for defaults, `false` to hard-disable (even when its env vars are
 * set), or an options object passed through to the adapter. Passthrough, because each adapter owns
 * its own option names — validating them here would mean this file had to know all three.
 */
const telemetryProviderSchema = z.union([z.boolean(), z.object({}).passthrough()]);

/** `telemetry` — which backends runs report to. See the field docs on {@link langgraphJsonSchema}. */
const telemetrySchema = z
  .object({
    langsmith: telemetryProviderSchema.optional(),
    posthog: telemetryProviderSchema.optional(),
    otel: telemetryProviderSchema.optional(),
    /** Your own sinks, as `"./telemetry.ts:sink"` specs — the same form as `auth.path`. */
    paths: z.array(z.string()).optional(),
  })
  .passthrough();

/** The validated `telemetry` block. */
export type TelemetryConfig = z.infer<typeof telemetrySchema>;

export const langgraphJsonSchema = z
  .object({
    /** REQUIRED: map of graph id → "path:export". */
    graphs: z.record(z.string()),
    /** JS/Node runtime pin (used by `skein build` / `dockerfile`). */
    node_version: z.string().optional(),
    /** `.env` path or an inline map, loaded into `process.env` at boot. */
    env: z.union([z.string(), z.record(z.string())]).optional(),
    /** Long-term memory store config. */
    store: z
      .object({ index: storeIndexSchema.optional(), ttl: storeTtlSchema.optional() })
      .passthrough()
      .optional(),
    /** Checkpointer backend; `"default"` == Postgres, absent == in-memory. */
    checkpointer: z.object({ type: z.string() }).passthrough().optional(),
    /** Server customization (CORS, route toggles) applied by the framework adapter. */
    http: z.object({}).passthrough().optional(),
    /**
     * Custom authentication + authorization. `path` is a `"file:export"` spec pointing at a module
     * that default-exports (or named-exports) an `@langchain/langgraph-sdk/auth` `Auth` instance;
     * when absent, every request is allowed (unauthenticated — the current behavior). Matches the
     * LangGraph CLI's `auth` block, including `disable_studio_auth`.
     */
    auth: z
      .object({
        path: z.string(),
        disable_studio_auth: z.boolean().optional().default(false),
      })
      .passthrough()
      .optional(),
    /**
     * Where runs report themselves — traces and lifecycle events. A skein extension (the LangGraph
     * CLI has no equivalent); additive, so a config carrying it still loads under `langgraph dev`.
     *
     * Each provider is `true` to enable with defaults, `false` to hard-disable even when its
     * environment variables are present, or an options object. Omitting a provider leaves it to
     * environment auto-detection. `paths` point at your own `TelemetrySink` exports, `"file:export"`
     * like `auth.path`. See docs/observability.md.
     */
    telemetry: telemetrySchema.optional(),
    /** Extra lines appended by `skein dockerfile` / `build`. */
    dockerfile_lines: z.array(z.string()).optional(),
    /** Dependency hints for image builds. */
    dependencies: z.array(z.string()).optional(),
  })
  .passthrough();

/** The validated `langgraph.json` shape (unknown keys preserved via passthrough). */
export type LanggraphJson = z.infer<typeof langgraphJsonSchema>;

/** Validate parsed JSON against the {@link langgraphJsonSchema}, throwing on any violation. */
export function parseLanggraphJson(raw: unknown): LanggraphJson {
  const result = langgraphJsonSchema.safeParse(raw);
  if (!result.success) {
    throw new SkeinConfigError("Invalid langgraph.json.", {
      cause: result.error,
      details: result.error.issues,
    });
  }
  return result.data;
}
