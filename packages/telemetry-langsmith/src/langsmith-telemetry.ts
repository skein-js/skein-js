// LangSmith tracing for skein runs.
//
// The reuse-first observation that shapes this whole file: **LangSmith tracing already works**.
// `@langchain/core` installs a global tracer whenever `LANGSMITH_TRACING` is truthy, and from there
// every LLM, tool, and chain call inside a graph is instrumented without anyone's help. What it
// produces without skein is a pile of anonymous root traces — no thread, no assistant, no user —
// because nothing tells LangSmith what a "run" is here.
//
// So this sink's job is *identity, not instrumentation*: it supplies `session_id` — the key
// LangSmith's Threads view groups on — plus the assistant and user ids that make a trace searchable.
// (The engine already stamps neutral identity: `run_id`, `thread_id`, `graph_id`.)
//
// It deliberately does **not** attach a `LangChainTracer` of its own. Doing so alongside the global
// tracer would send every span to LangSmith twice, which is worse than not tracing at all: you pay
// double and you can't trust the numbers. One tracer, configured properly, is the whole design.
//
// Two rules about the environment, both about not surprising an operator:
//
//   * **Credentials are read, never written.** An API key handed to this function stays in this
//     function. Assigning it to `process.env` would widen a secret to every module in the process,
//     every child process spawned afterwards, and anything that dumps the environment on a crash.
//   * **Tracing is switched on only when explicitly asked for** (`enableTracing`, which the config
//     loader sets when `langgraph.json` declares `telemetry.langsmith`). Turning it on uploads every
//     prompt, tool argument, and model response — i.e. your users' messages — to a third party.
//     Merely finding a credential in the environment is not consent for that; `LANGSMITH_TRACING=true`
//     or an explicit config entry is.

import type { TelemetrySink } from "@skein-js/core";

/** A read-only view of the environment. `process.env` in practice; injected in tests. */
type Environment = Record<string, string | undefined>;

export interface LangSmithTelemetryOptions {
  /** The LangSmith project traces land in. Defaults to `LANGSMITH_PROJECT` / `LANGCHAIN_PROJECT`. */
  projectName?: string;
  /**
   * Switch LangChain's global tracer on if it isn't already, by setting `LANGSMITH_TRACING`.
   * **Off by default** — see the header: enabling tracing starts sending user content to LangSmith,
   * so it takes an explicit request. `skein` passes `true` when `langgraph.json` declares
   * `telemetry.langsmith`; setting `LANGSMITH_TRACING=true` yourself has the same effect.
   *
   * An existing value is never overwritten, so a deliberate `LANGSMITH_TRACING=false` is respected.
   *
   * Credentials are **not** written to the environment either way. Set `LANGSMITH_API_KEY` (and, for
   * self-hosted, `LANGSMITH_ENDPOINT`) in the environment — that is where LangChain's tracer reads
   * them from.
   */
  enableTracing?: boolean;
  /** Environment to read (and, with {@link enableTracing}, to set `LANGSMITH_TRACING` in). */
  env?: Environment;
}

/** Read the first set value among `names` — LangSmith's current name first, legacy `LANGCHAIN_` after. */
function readEnv(env: Environment, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function processEnv(): Environment {
  return (globalThis as { process?: { env?: Environment } }).process?.env ?? {};
}

/**
 * Whether LangChain's global tracer is already switched on. Exported so the runtime's provider
 * detection can require it: finding a `LANGSMITH_API_KEY` is not on its own a request to start
 * shipping user content off-box, but `LANGSMITH_TRACING=true` is.
 */
export function isLangSmithTracingEnabled(env: Environment = processEnv()): boolean {
  const value = readEnv(env, "LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2");
  // LangSmith treats these as true; anything else, including unset, is false.
  return value === "true" || value === "1";
}

/**
 * Build a {@link TelemetrySink} that makes skein's runs legible in LangSmith, or `undefined` when
 * LangSmith is not configured — so a caller can pass the result straight through without branching.
 *
 * Enabled when an API key is present (from `options` or the environment), or when a `projectName` is
 * given explicitly.
 *
 * ```ts
 * const telemetry = createLangSmithTelemetry();
 * const deps = embedInMemoryGraphs(graphs, { overrides: telemetry ? { telemetry } : {} });
 * ```
 *
 * Traces are grouped into LangSmith **Threads** by `session_id`, which is set to skein's thread id —
 * so a conversation reads as one thread there just as it does through the Agent Protocol.
 */
export function createLangSmithTelemetry(
  options: LangSmithTelemetryOptions = {},
): TelemetrySink | undefined {
  const env = options.env ?? processEnv();

  const apiKey = readEnv(env, "LANGSMITH_API_KEY", "LANGCHAIN_API_KEY");
  const projectName = options.projectName ?? readEnv(env, "LANGSMITH_PROJECT", "LANGCHAIN_PROJECT");
  if (apiKey === undefined && projectName === undefined) return undefined;

  // Switch the global tracer on, but only when explicitly asked to, and only if the operator hasn't
  // already answered the question — a deliberate `LANGSMITH_TRACING=false` stands. Note this sets the
  // *switch* and nothing else: no credential is ever written to the environment.
  if (
    options.enableTracing === true &&
    readEnv(env, "LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2") === undefined
  ) {
    env["LANGSMITH_TRACING"] = "true";
  }

  // A project name is worth stamping on traces even when it came from options rather than the
  // environment, so the tracer files them under the right project. Not a secret, and never overwrites.
  if (projectName !== undefined && env["LANGSMITH_PROJECT"] === undefined) {
    env["LANGSMITH_PROJECT"] = projectName;
  }

  return {
    name: "langsmith",

    traceMetadata(context) {
      const metadata: Record<string, unknown> = {
        // `session_id` is the key LangSmith's Threads view groups on. Emitting it is what turns a
        // pile of unrelated traces into a readable conversation.
        session_id: context.threadId,
        skein_trigger: context.trigger,
      };
      if (context.assistantId !== undefined) metadata["skein_assistant_id"] = context.assistantId;
      if (context.userId !== undefined) metadata["ls_user_id"] = context.userId;
      return metadata;
    },

    traceTags(context) {
      const tags = [`trigger:${context.trigger}`];
      if (context.assistantId !== undefined) tags.push(`assistant:${context.assistantId}`);
      return tags;
    },

    async flush() {
      // LangSmith submits traces in background batches, so a process that exits promptly after a run
      // loses them. `awaitAllCallbacks` is LangChain's own "wait for pending callback work" barrier —
      // it covers the global tracer, which is the one actually doing the sending here.
      try {
        const { awaitAllCallbacks } = (await import("@langchain/core/callbacks/promises")) as {
          awaitAllCallbacks?: () => Promise<void>;
        };
        await awaitAllCallbacks?.();
      } catch {
        // `@langchain/core` absent or without that export — nothing to drain, and a failure to flush
        // must never break shutdown.
      }
    },
  };
}
