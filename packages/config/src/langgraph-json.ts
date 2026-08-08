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
    // Bounded here as well as in the store: pgvector's own ceiling, and the store interpolates this
    // into a type modifier, so a bad value should fail while parsing config rather than at boot.
    dims: z.number().int().positive().max(16_000).optional(),
    fields: z.array(z.string()).optional(),
    /**
     * Build an HNSW index on the embedding column (skein extension, not a LangGraph key).
     *
     * Off by default, and deliberately opt-in rather than inferred: HNSW is an **approximate**
     * nearest-neighbour index, so enabling it changes which rows a semantic search returns. Without
     * it every search is an exact scan computing cosine distance over every row — correct, and fine
     * until the store is large.
     */
    hnsw: z.boolean().optional(),
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
 * `checkpointer.ttl` — expiry policy for **threads**, matching LangGraph Platform's `langgraph.json`
 * shape so the same config file works under both. Durations are in minutes, like `store.ttl`.
 *
 * `strategy` is accepted for that compatibility and only `"delete"` is meaningful: an expired thread
 * is removed along with its runs and checkpoints. There is nothing else a thread could expire *into*.
 *
 * Note the open-source `@langchain/langgraph-api` ignores thread TTL entirely — it is a Platform-only
 * feature there — so this is skein going past LangGraph OSS rather than catching up to it.
 */
const checkpointerTtlSchema = z
  .object({
    /** Default thread lifetime in minutes when a create passes no `ttl`. */
    default_ttl: z.number().optional(),
    /** What expiry does. Only `"delete"` is implemented. */
    strategy: z.literal("delete").optional(),
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

/**
 * `skein.idempotency` — retention for `Idempotency-Key` records.
 *
 * A skein original, so it lives under the reserved `skein` namespace rather than at the top level:
 * a top-level key would collide if LangGraph ever claimed the same name, and there would be no good
 * way to resolve it.
 *
 * Tuning only. Omitting the block does **not** disable the header — a caller who sends one has been
 * promised their retry will not start a second run, and honouring that is not a deployment opinion.
 */
const idempotencySchema = z
  .object({
    // All three are `.positive()`, not bare numbers. Zero would pass a bare `z.number()` and then
    // survive the `?? default` fallback (`??` only falls through on nullish), so `retention_hours: 0`
    // would write every record already expired and silently stop every replay — turning a block whose
    // own documentation says it "is tuning, not an on/off switch" into exactly that off switch.
    // `in_flight_minutes: 0` is worse: a concurrent retry takes over a live claim at once and starts
    // the second run. `sweep_interval_minutes: 0` makes the sweeper a `setTimeout(…, 0)` busy loop.
    /** How long a recorded response stays replayable, in hours (default 24). */
    retention_hours: z.number().positive().optional(),
    /** How long an unfinished claim blocks a retry, in minutes (default 15). */
    in_flight_minutes: z.number().positive().optional(),
    /** How often the background sweeper reclaims expired records, in minutes (default 60). */
    sweep_interval_minutes: z.number().positive().optional(),
  })
  .passthrough();

/** The validated `skein.idempotency` block. */
export type IdempotencyJsonConfig = z.infer<typeof idempotencySchema>;

const runtimeSchema = z
  .object({
    /** Native runtime used by the built production artifact. */
    name: z.enum(["node", "bun", "deno"]),
    /** Official image tag/version. Omit to use Skein's tested default. */
    version: z.string().trim().min(1).optional(),
  })
  .passthrough();

export type SkeinRuntimeName = z.infer<typeof runtimeSchema>["name"];

export const langgraphJsonSchema = z
  .object({
    /** REQUIRED: map of graph id → "path:export". */
    graphs: z.record(z.string()),
    /** JS/Node runtime pin (used by `skein build` / `dockerfile`). */
    node_version: z.string().optional(),
    /** Skein production settings. Unknown keys remain forward-compatible. */
    skein: z
      .object({
        runtime: runtimeSchema.optional(),
        idempotency: idempotencySchema.optional(),
      })
      .passthrough()
      .optional(),
    /** `.env` path or an inline map, loaded into `process.env` at boot. */
    env: z.union([z.string(), z.record(z.string())]).optional(),
    /** Long-term memory store config. */
    store: z
      .object({
        index: storeIndexSchema.optional(),
        ttl: storeTtlSchema.optional(),
        /**
         * `"./path:export"` of a bring-your-own long-term-memory store — a skein `StoreRepo` or a
         * LangGraph `BaseStore` (`PostgresStore`, `InMemoryStore`, your own). A skein extension, not a
         * LangGraph key, but it belongs under `store` because that is what it replaces.
         *
         * Only the memory repo is substituted; assistants, threads, runs, crons and idempotency keep
         * using the configured driver.
         */
        adapter: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    /** Checkpointer backend; `"default"` == Postgres, absent == in-memory. Plus `ttl` — thread expiry. */
    checkpointer: z
      .object({ type: z.string().optional(), ttl: checkpointerTtlSchema.optional() })
      .passthrough()
      .optional(),
    /**
     * Server customization applied by the framework adapter: `cors`, plus LangGraph's `disable_*`
     * route toggles. Still `.passthrough()`, so a key skein does not implement yet (`http.app`) is
     * carried rather than rejected — a `langgraph.json` must keep loading under both CLIs.
     */
    http: z
      .object({
        cors: z.object({}).passthrough().optional(),
        // Declared as `unknown`, not `boolean`. This block used to be opaque
        // (`z.object({}).passthrough()`), so a config carrying `"disable_runs": "${DISABLE_RUNS}"` — env
        // substitution, which this loader supports — or a hand-written `"true"` string loaded fine.
        // Typing these as booleans would turn those into a *startup failure*, since `parseLanggraphJson`
        // throws on any violation. Only a literal `true` disables a group; that decision lives in
        // `disabledRoutesFromHttpConfig`, which is also where the string/number cases are handled.
        disable_assistants: z.unknown().optional(),
        disable_threads: z.unknown().optional(),
        disable_runs: z.unknown().optional(),
        /**
         * Turns off the crons resource — both the HTTP routes and the scheduler, so a disabled
         * deployment does not keep firing schedules it will not let anyone see or cancel.
         */
        disable_crons: z.unknown().optional(),
        disable_store: z.unknown().optional(),
        /** Turns off `GET /info`. skein's `/ok` health probe is unaffected — see meta/server-info.ts. */
        disable_meta: z.unknown().optional(),
        /**
         * Serve the skein console (`@skein-js/console`) — a skein extension, so a config carrying it
         * still loads under `langgraph dev`.
         *
         * **Off unless this says otherwise.** `skein dev` serves the console by default because a dev
         * server is where you want it; a deployed server does not, because the console is full API
         * power over threads, store and crons. Set `true` to serve it at `/console`, or a string to
         * choose the path (`"/admin/console"`). Same `unknown` typing as the `disable_*` flags, for
         * the same reason: an env-substituted `"false"` must not read as enabled.
         */
        console: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
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
