// Turn a `langgraph.json` `telemetry` block (plus the environment) into the `TelemetrySink`s the run
// engine reports to.
//
// This lives in @skein-js/runtime rather than @skein-js/config for the same reason `resolve-embed.ts`
// does: it **dynamically imports optional packages**. `@skein-js/langsmith`, `@skein-js/posthog`, and
// `@skein-js/otel` are never listed as dependencies here — a deployment installs only the ones it
// uses, and a missing one produces an actionable "install this" error rather than a module-not-found.
//
// Precedence, highest first:
//
//   1. `deps.telemetry` passed in code — this file is never consulted (see build-runtime.ts).
//   2. The `telemetry` block: `false` hard-disables a provider even when its env vars are set.
//   3. A provider the block doesn't mention: enabled if its environment says so.
//   4. Nothing configured: no telemetry, and the engine's guards make it free.

import { pathToFileURL } from "node:url";

import { parseGraphSpec, type ModuleImporter, type TelemetryConfig } from "@skein-js/config";
import type { TelemetrySink } from "@skein-js/core";

import { RuntimeConfigError } from "./errors.js";

/** A provider's entry: the optional package it needs, and how to build its sink from that module. */
interface TelemetryProvider {
  /** The npm package a deployment must install to use this provider. */
  package: string;
  /** The factory export inside that package. */
  exportName: string;
  /**
   * Whether the environment alone is enough to switch this provider on, for a config that doesn't
   * mention it. Deliberately conservative: only an unambiguous "I configured this" signal counts.
   */
  detect(env: Record<string, string | undefined>): boolean;
  /**
   * Whether the factory reads configuration from the environment, in which case it is handed the
   * same one {@link detect} saw. Without this, detection and configuration could read different
   * environments — indistinguishable in production, where both are `process.env`, and impossible to
   * test.
   */
  readsEnv?: boolean;
}

const PROVIDERS: Record<string, TelemetryProvider> = {
  langsmith: {
    package: "@skein-js/langsmith",
    exportName: "createLangSmithTelemetry",
    readsEnv: true,
    // Requires `LANGSMITH_TRACING` **and** a key. A credential on its own is not consent: turning
    // tracing on uploads every prompt and model response — your users' messages — to a third party,
    // and plenty of environments carry a LangSmith key for unrelated tooling. `LANGSMITH_TRACING=true`
    // is LangChain's own opt-in, so we take that as the signal and nothing weaker.
    detect: (env) =>
      (env["LANGSMITH_TRACING"] === "true" ||
        env["LANGSMITH_TRACING"] === "1" ||
        env["LANGCHAIN_TRACING_V2"] === "true" ||
        env["LANGCHAIN_TRACING_V2"] === "1") &&
      Boolean(env["LANGSMITH_API_KEY"] ?? env["LANGCHAIN_API_KEY"]),
  },
  posthog: {
    package: "@skein-js/posthog",
    exportName: "createPostHogTelemetry",
    readsEnv: true,
    detect: (env) => Boolean(env["POSTHOG_API_KEY"]),
  },
  otel: {
    package: "@skein-js/otel",
    exportName: "createOtelTelemetry",
    // Any of the standard OTel exporter/SDK env vars means an OTel pipeline is set up.
    detect: (env) =>
      Boolean(
        env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
        env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ??
        env["OTEL_SERVICE_NAME"],
      ),
  },
};

export interface ResolveTelemetryOptions {
  /** The `telemetry` block from `langgraph.json`, if any. */
  config?: TelemetryConfig;
  /** Directory holding `langgraph.json`, used to resolve a custom sink path. */
  configDir: string;
  /** TS-capable importer (the CLI's vite loader) for a custom-sink `.ts` path. */
  importModule?: ModuleImporter;
  /** Environment to auto-detect from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function processEnv(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/** A provider's setting: `true`/`false`/options object, or `undefined` when the config omits it. */
type ProviderSetting = boolean | Record<string, unknown> | undefined;

/** How a provider came to be enabled — which decides how loudly a missing package fails. */
interface ProviderDecision {
  options: Record<string, unknown>;
  /** True when `langgraph.json` named it; false when only the environment suggested it. */
  declared: boolean;
}

/**
 * Whether a provider should be built, and with what options. Returns `undefined` for "off", so the
 * caller can skip the import entirely rather than paying for a module it won't use.
 */
function resolveSetting(
  setting: ProviderSetting,
  provider: TelemetryProvider,
  env: Record<string, string | undefined>,
): ProviderDecision | undefined {
  if (setting === false) return undefined; // explicit opt-out beats any environment
  if (setting === true) return { options: {}, declared: true };
  if (typeof setting === "object") return { options: setting, declared: true };
  // Unmentioned: let the environment decide, but only as a suggestion — see `buildProviderSink`.
  return provider.detect(env) ? { options: {}, declared: false } : undefined;
}

/**
 * Import a provider package and call its factory.
 *
 * A missing package is fatal only for a provider the config **declared**: you asked for it, so a
 * silent no-op would be worse than a startup error naming what to install. A provider that was only
 * *detected* from the environment degrades to off instead — variables like `OTEL_SERVICE_NAME` and
 * `LANGSMITH_API_KEY` are routinely injected by platforms and unrelated tooling, and refusing to boot
 * over telemetry nobody configured would be a hostile surprise.
 */
async function buildProviderSink(
  name: string,
  provider: TelemetryProvider,
  decision: ProviderDecision,
): Promise<TelemetrySink | undefined> {
  let module: Record<string, unknown>;
  try {
    module = (await import(provider.package)) as Record<string, unknown>;
  } catch {
    if (!decision.declared) return undefined;
    throw new RuntimeConfigError(
      `telemetry.${name} is enabled, so install ${provider.package} in your project ` +
        `(and its peer SDK — see docs/observability.md).`,
    );
  }
  const factory = module[provider.exportName];
  if (typeof factory !== "function") {
    throw new RuntimeConfigError(`${provider.package} does not export "${provider.exportName}".`);
  }
  // Each factory returns `undefined` when its own configuration is incomplete (no API key, say), so
  // an enabled-but-unconfigured provider degrades to "off" rather than to a broken sink.
  return (factory as (options: Record<string, unknown>) => TelemetrySink | undefined)(
    decision.options,
  );
}

/** Load a user's own sink from a `"./telemetry.ts:sink"` spec — the same form as `auth.path`. */
async function loadCustomSink(
  spec: string,
  options: ResolveTelemetryOptions,
): Promise<TelemetrySink> {
  const { sourceFile, exportSymbol } = parseGraphSpec(spec, options.configDir);
  const importer: ModuleImporter =
    options.importModule ??
    ((file) => import(pathToFileURL(file).href) as Promise<Record<string, unknown>>);
  const module = await importer(sourceFile);
  const exported = module[exportSymbol];
  if (exported === undefined) {
    throw new RuntimeConfigError(
      `telemetry path "${spec}" — module "${sourceFile}" has no export "${exportSymbol}".`,
    );
  }
  // Accept either a sink or a factory returning one, so a user's module can read its own config.
  const sink = typeof exported === "function" ? (exported as () => unknown)() : exported;
  if (
    typeof sink !== "object" ||
    sink === null ||
    typeof (sink as TelemetrySink).name !== "string"
  ) {
    throw new RuntimeConfigError(
      `telemetry path "${spec}" must resolve to a TelemetrySink (an object with a \`name\`), ` +
        `or a function returning one.`,
    );
  }
  return sink as TelemetrySink;
}

/**
 * Build every configured telemetry sink. Returns an empty array when nothing is configured, so the
 * caller can leave `ProtocolDeps.telemetry` unset and the engine pays nothing.
 */
export async function resolveTelemetry(options: ResolveTelemetryOptions): Promise<TelemetrySink[]> {
  const env = options.env ?? processEnv();
  const config = options.config;
  const sinks: TelemetrySink[] = [];

  for (const [name, provider] of Object.entries(PROVIDERS)) {
    const decision = resolveSetting(config?.[name] as ProviderSetting, provider, env);
    if (decision === undefined) continue;
    // Hand the adapter the same environment detection used, so the two can never disagree. The
    // config block still wins — an explicit `env` there is left alone. `enableTracing` rides along
    // for a *declared* provider only: switching LangSmith's global tracer on starts sending user
    // content off-box, so it follows the config, never a stray environment variable.
    const factoryOptions =
      provider.readsEnv && decision.options["env"] === undefined
        ? { ...(decision.declared ? { enableTracing: true } : {}), ...decision.options, env }
        : decision.options;
    const sink = await buildProviderSink(name, provider, { ...decision, options: factoryOptions });
    if (sink) sinks.push(sink);
  }

  for (const spec of config?.paths ?? []) {
    sinks.push(await loadCustomSink(spec, options));
  }

  return sinks;
}

/**
 * The npm packages a `telemetry` block needs **installed at runtime**. Each is dynamically imported
 * (see {@link resolveTelemetry}) and never referenced by graph code, so `skein build` can't discover
 * them while bundling — it must pin them into the production image explicitly. The same treatment
 * `providerEmbedPackage` gives `store.index.embed`.
 *
 * Environment-detected providers are deliberately **excluded**: the environment at build time is not
 * the environment at run time, and pinning a package because a build machine happened to export
 * `OTEL_SERVICE_NAME` would be surprising. Declare the provider in `langgraph.json` to have it pinned.
 */
export function telemetryRuntimePackages(config: TelemetryConfig | undefined): string[] {
  if (!config) return [];
  return Object.entries(PROVIDERS)
    .filter(([name]) => config[name] !== undefined && config[name] !== false)
    .map(([, provider]) => provider.package);
}
