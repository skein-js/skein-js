// PostHog analytics for skein runs — two layers, because PostHog answers two different questions.
//
//   1. **Run lifecycle.** `skein_run_started` / `skein_run_finished`, carrying status, duration,
//      queue wait, frame count, and the graph/assistant/thread it belongs to. This is the operational
//      picture: how often runs fail, how long they take, which graph is slow.
//   2. **LLM analytics.** PostHog's `$ai_generation` event schema, emitted per model call with token
//      counts and latency. This is what populates PostHog's LLM Analytics dashboards — cost per
//      user, tokens per conversation, which model is being called. skein can't see any of it from
//      the engine (tokens exist only inside LangChain's callbacks), so this half is a callback
//      handler rather than a lifecycle event.
//
// Both are correlated by `$ai_trace_id`, which is skein's run id — so a generation can always be
// traced back to the run and thread that produced it.
//
// `posthog-node` is an optional peer, resolved on first use. If it isn't installed the sink still
// constructs and simply drops events, rather than failing a run at import time.

import type { RunTelemetryContext, RunTelemetryEvent, TelemetrySink } from "@skein-js/core";

/**
 * The slice of `posthog-node`'s client this sink uses. Declared locally so the package needs no
 * runtime dependency on it — the same approach `@skein-js/agent-protocol` takes with `fetch`.
 */
export interface PostHogClientLike {
  capture(event: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  flush?(): Promise<unknown>;
  shutdown?(): Promise<unknown> | void;
}

export interface PostHogTelemetryOptions {
  /** Project API key. Defaults to `POSTHOG_API_KEY`. */
  apiKey?: string;
  /** Ingestion host. Defaults to `POSTHOG_HOST`, then PostHog US cloud. */
  host?: string;
  /**
   * Emit `$ai_generation` events for individual model calls. On by default — it's the reason to
   * choose PostHog over a plain metrics backend. Turn off to capture run lifecycle only.
   */
  captureGenerations?: boolean;
  /**
   * Who a run is attributed to. Defaults to the authenticated user's identity, falling back to the
   * thread id so anonymous traffic still groups per conversation rather than collapsing into one
   * distinct id.
   */
  distinctId?: (context: RunTelemetryContext) => string;
  /** A pre-built PostHog client. Supply one to control batching, or to capture events in tests. */
  client?: PostHogClientLike;
  /** Environment to read configuration from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** PostHog's US cloud ingestion host — their default, and ours. */
const DEFAULT_HOST = "https://us.i.posthog.com";

/**
 * How many events to hold while `posthog-node` is still being imported. Generous enough that a
 * burst of cold-start runs survives, bounded so a host that never installs the package (or whose
 * import fails) cannot grow this without limit.
 */
const MAX_BUFFERED_EVENTS = 1_000;

function processEnv(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/** Drop undefined values, so PostHog never receives a property whose value is literally absent. */
function defined(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

/** The run identity every event carries, so any of them can be grouped or joined. */
function runProperties(context: RunTelemetryContext): Record<string, unknown> {
  return defined({
    $ai_trace_id: context.runId,
    run_id: context.runId,
    thread_id: context.threadId,
    assistant_id: context.assistantId,
    graph_id: context.graphId,
    trigger: context.trigger,
    stream_modes: context.streamModes,
  });
}

/**
 * Read token usage from a LangChain LLM result. Providers disagree about where they put it and what
 * they call it, so this checks the three shapes in circulation and gives up quietly rather than
 * reporting a wrong number.
 */
function readTokenUsage(output: unknown): { input?: number; output?: number; total?: number } {
  const llmOutput = (output as { llmOutput?: Record<string, unknown> } | undefined)?.llmOutput;
  // Modern LangChain puts normalized counts on the message itself (`usage_metadata`), which is the
  // one shape that agrees across providers. `llmOutput.tokenUsage` is the older OpenAI-shaped path,
  // still emitted by several integrations, so both are checked — normalized first.
  const message = (
    output as { generations?: { message?: { usage_metadata?: Record<string, unknown> } }[][] }
  )?.generations?.[0]?.[0]?.message?.usage_metadata;
  const source =
    message ??
    (llmOutput?.["tokenUsage"] as Record<string, unknown> | undefined) ??
    (llmOutput?.["usage"] as Record<string, unknown> | undefined);
  if (!source) return {};

  const pick = (...names: string[]): number | undefined => {
    for (const name of names) {
      const value = source[name];
      if (typeof value === "number") return value;
    }
    return undefined;
  };

  return defined({
    input: pick("promptTokens", "prompt_tokens", "input_tokens", "inputTokens"),
    output: pick("completionTokens", "completion_tokens", "output_tokens", "outputTokens"),
    total: pick("totalTokens", "total_tokens"),
  }) as { input?: number; output?: number; total?: number };
}

/**
 * Best-effort model name from the `extraParams.invocation_params` LangChain hands to `*Start`
 * handlers. Note this is only available at *start* — `handleLLMEnd` receives `(output, runId,
 * parentRunId, tags)` and nothing about the model — which is why the handler below remembers it.
 */
function readModelName(extraParams: unknown): string | undefined {
  const invocation = (extraParams as { invocation_params?: Record<string, unknown> } | undefined)
    ?.invocation_params;
  for (const key of ["model", "model_name", "modelName", "deployment"]) {
    const value = invocation?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** The provider class LangChain serialized (`["langchain","chat_models","openai","ChatOpenAI"]`). */
function readProvider(llm: unknown): string | undefined {
  const id = (llm as { id?: unknown } | undefined)?.id;
  if (!Array.isArray(id)) return undefined;
  const last = id[id.length - 1];
  return typeof last === "string" && last.length > 0 ? last : undefined;
}

/**
 * A LangChain callback handler emitting PostHog's `$ai_generation` schema. Written as a plain object
 * rather than a `BaseCallbackHandler` subclass so this package needs no runtime dependency on
 * `@langchain/core` — LangChain accepts a bare methods object in a `callbacks` array.
 */
function createGenerationHandler(
  capture: (event: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }) => void,
  distinctId: string,
  context: RunTelemetryContext,
): Record<string, unknown> {
  /** What we learned at `*Start` and need again at `*End`, keyed by LangChain's per-call run id. */
  interface PendingGeneration {
    startedAt: number;
    model?: string;
    provider?: string;
  }
  const pending = new Map<string, PendingGeneration>();

  const begin = (llm: unknown, runId: string, extraParams: unknown): void => {
    pending.set(runId, {
      startedAt: Date.now(),
      ...defined({ model: readModelName(extraParams), provider: readProvider(llm) }),
    });
  };

  /**
   * The record for a finishing generation, or `undefined` when no matching start was seen — which
   * happens if the handler was attached mid-call, or a provider integration fires only the end hook.
   */
  const settle = (runId: string): PendingGeneration | undefined => {
    const record = pending.get(runId);
    pending.delete(runId);
    return record;
  };

  /**
   * Seconds elapsed, or `undefined` when the start was never seen. Deliberately not "0": a fabricated
   * zero drags PostHog's latency percentiles down with a number that is simply false. Same policy
   * `readTokenUsage` follows — omit what you don't know.
   */
  const latencySeconds = (record: PendingGeneration | undefined): number | undefined =>
    record === undefined ? undefined : (Date.now() - record.startedAt) / 1000;

  return {
    name: "skein-posthog-generation",
    // Emitting an analytics event must not hold up the graph — `capture` buffers, so this is cheap.
    awaitHandlers: false,

    handleLLMStart(
      llm: unknown,
      _prompts: unknown,
      runId: string,
      _parentRunId?: string,
      extraParams?: unknown,
    ): void {
      begin(llm, runId, extraParams);
    },

    // Chat models take a separate entry point, and it is the one that actually fires for the
    // `ChatOpenAI`/`ChatAnthropic`/`ChatGoogleGenerativeAI` classes agents are built from.
    handleChatModelStart(
      llm: unknown,
      _messages: unknown,
      runId: string,
      _parentRunId?: string,
      extraParams?: unknown,
    ): void {
      begin(llm, runId, extraParams);
    },

    handleLLMEnd(output: unknown, runId: string): void {
      const record = settle(runId);
      const usage = readTokenUsage(output);
      capture({
        distinctId,
        event: "$ai_generation",
        properties: defined({
          ...runProperties(context),
          $ai_span_id: runId,
          $ai_model: record?.model,
          $ai_provider: record?.provider,
          $ai_input_tokens: usage.input,
          $ai_output_tokens: usage.output,
          $ai_total_tokens: usage.total,
          $ai_latency: latencySeconds(record),
          $ai_is_error: false,
        }),
      });
    },

    handleLLMError(error: unknown, runId: string): void {
      const record = settle(runId);
      capture({
        distinctId,
        event: "$ai_generation",
        properties: defined({
          ...runProperties(context),
          $ai_span_id: runId,
          $ai_model: record?.model,
          $ai_provider: record?.provider,
          $ai_latency: latencySeconds(record),
          $ai_is_error: true,
          $ai_error: error instanceof Error ? error.message : String(error),
        }),
      });
    },
  };
}

/**
 * Build a {@link TelemetrySink} that reports skein runs to PostHog, or `undefined` when PostHog is
 * not configured — so a caller can pass the result straight through without branching.
 *
 * ```ts
 * const telemetry = createPostHogTelemetry();
 * const deps = embedInMemoryGraphs(graphs, { overrides: telemetry ? { telemetry } : {} });
 * ```
 */
export function createPostHogTelemetry(
  options: PostHogTelemetryOptions = {},
): TelemetrySink | undefined {
  const env = options.env ?? processEnv();
  const apiKey = options.apiKey ?? env["POSTHOG_API_KEY"];
  if (apiKey === undefined && options.client === undefined) return undefined;

  const host = options.host ?? env["POSTHOG_HOST"] ?? DEFAULT_HOST;
  const captureGenerations = options.captureGenerations ?? true;
  const identify = options.distinctId ?? ((context) => context.userId ?? context.threadId);

  // `posthog-node` is an optional peer, so it is imported dynamically — which means the client is
  // not ready synchronously. Anything captured before it resolves is buffered rather than dropped:
  // without that, a process's first run loses its `skein_run_started` and every `$ai_generation` it
  // produced, silently.
  let client = options.client;
  type PendingCapture = Parameters<PostHogClientLike["capture"]>[0];
  let buffered: PendingCapture[] | undefined = client === undefined ? [] : undefined;

  const capture = (event: PendingCapture): void => {
    if (client) {
      client.capture(event);
      return;
    }
    // Bounded: a host that never installs `posthog-node` must not accumulate events forever.
    if (buffered && buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event);
  };

  if (client === undefined && apiKey !== undefined) {
    void (async () => {
      try {
        const { PostHog } = (await import("posthog-node")) as {
          PostHog: new (key: string, config?: { host?: string }) => PostHogClientLike;
        };
        client = new PostHog(apiKey, { host });
      } catch {
        // `posthog-node` not installed — nothing to send to.
      }
      const pending = buffered ?? [];
      buffered = undefined;
      if (client) for (const event of pending) client.capture(event);
    })();
  }

  return {
    name: "posthog",

    onRunEvent(event: RunTelemetryEvent) {
      const distinctId = identify(event.context);

      if (event.type === "run.started") {
        capture({
          distinctId,
          event: "skein_run_started",
          properties: defined({ ...runProperties(event.context), queue_ms: event.queuedMs }),
        });
        return;
      }

      capture({
        distinctId,
        event: "skein_run_finished",
        properties: defined({
          ...runProperties(event.context),
          status: event.status,
          duration_ms: event.durationMs,
          frame_count: event.frameCount,
          is_error: event.status === "error" || event.status === "timeout",
          error_name: event.error?.name,
          error_message: event.error?.message,
          failing_nodes: event.failingNodes?.length === 0 ? undefined : event.failingNodes,
        }),
      });
    },

    callbacks(context) {
      if (!captureGenerations) return [];
      return [createGenerationHandler(capture, identify(context), context)];
    },

    async flush() {
      await client?.flush?.();
    },

    async shutdown() {
      await client?.shutdown?.();
    },
  };
}
