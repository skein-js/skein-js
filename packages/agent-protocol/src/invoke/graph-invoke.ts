// The simplified serving surface: one graph, one endpoint, called like a function.
//
// `POST <prefix>/:graph_id` runs a graph to completion and returns its final state — the request body
// IS the graph input, the response IS the final state. No threads, assistants, run rows, run queue,
// event bus, or durable checkpoints; those belong to the full Agent Protocol (see `skeinRoutes`).
// This is for non-chat workloads — a classifier, an extractor, a workflow you call from another
// service — where the protocol's conversational machinery is pure overhead.
//
// Two things are deliberately NOT skipped:
//   1. `deps.auth`, when configured. Invoking a graph runs it (spending model tokens), so this must
//      never be a way around the gate the protocol routes enforce. Same resource+action as a run.
//   2. The long-term store, bridged in as a `BaseStore` so nodes still reach `getStore()`.
//
// Each call is independent: a throwaway per-call checkpointer under a fresh thread id keeps graphs
// that require a checkpointer working while persisting nothing. That saver is attached to a per-call
// clone of the compiled graph (see `resolveCompiledGraph`) — the resolver memoizes one instance for
// every caller, so attaching it directly would hand this call's throwaway saver to a concurrent
// protocol run. Runs are also bounded by `deps.runTimeoutMs` and the caller's disconnect signal.
// See docs/serving-a-single-graph.md.

import { randomUUID } from "node:crypto";

import { MemorySaver, type CompiledGraph } from "@langchain/langgraph";
import {
  SkeinHttpError,
  type AuthContext,
  type RunFrame,
  type RunStatus,
  type StreamMode,
} from "@skein-js/core";
import { z } from "zod";

import { resolveAuthContext } from "../auth/authenticate-request.js";
import { authValue } from "../auth/route-authz.js";
import type { ProtocolHandler, ProtocolRequest, ProtocolResponse } from "../create-handlers.js";
import type { ProtocolDeps } from "../deps.js";
import { resolveCompiledGraph } from "../graphs/resolve-compiled-graph.js";
import type { RouteBinding } from "../http/routes.js";
import { serializeError } from "../normalize-error.js";
import { toGraphStreamModes, withAuthUser } from "../runs/run-input.js";
import { chunkToFrameBody, toRunFrame } from "../sse/run-frame-stream.js";
import { toSseEvents } from "../sse/sse.js";
import { parse, requireParam } from "../validation/parse.js";

/** The default path prefix the invoke endpoint mounts under. */
export const DEFAULT_INVOKE_PREFIX = "/invoke";

type InvokeOptions = Parameters<CompiledGraph<string>["invoke"]>[1];
type StreamOptions = Parameters<CompiledGraph<string>["stream"]>[1];

/** Options for {@link createGraphInvokeHandler}. */
export interface GraphInvokeOptions {
  /**
   * Stream modes used when the caller opts into SSE, overridable per request via `?stream_mode=`.
   * Defaults to `"values"` — each frame is the full state after a step, ending at the same value the
   * JSON response would have returned.
   */
  streamMode?: StreamMode | StreamMode[];
}

/** The single handler name this surface binds — deliberately not a `keyof ProtocolHandlers`. */
export type GraphInvokeHandlerName = "invokeGraph";

/**
 * The route table for the invoke surface — one POST, shaped like {@link skeinRoutes} so catch-all
 * adapters (NestJS, Next.js) can match it the same way and native routers can bind it directly.
 * Parameterized with its own handler name, so nothing can mistake it for a protocol-table lookup key.
 */
export function graphInvokeRoutes(
  prefix: string = DEFAULT_INVOKE_PREFIX,
): RouteBinding<GraphInvokeHandlerName>[] {
  return [{ method: "post", path: `${normalizePrefix(prefix)}/:graph_id`, handler: "invokeGraph" }];
}

/** Strip a trailing slash so `"/invoke/"` and `"/invoke"` produce the same path. Root → `""`. */
function normalizePrefix(prefix: string): string {
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return trimmed === "/" ? "" : trimmed;
}

/** True when the caller asked for an event stream rather than a single JSON response. */
function wantsEventStream(req: ProtocolRequest): boolean {
  return req.headers["accept"]?.includes("text/event-stream") ?? false;
}

/**
 * The abort signal governing one invocation: fires on `timeoutMs` (the same budget the run engine
 * applies via `deps.runTimeoutMs`) or when the caller's own signal aborts. `dispose()` clears the
 * timer and unsubscribes, so a finished call leaves nothing pending.
 */
function createRunSignal(
  timeoutMs: number | undefined,
  callerSignal: AbortSignal | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (timeoutMs === undefined && !callerSignal) return { signal: undefined, dispose: () => {} };

  const controller = new AbortController();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(new Error(`Run exceeded ${timeoutMs}ms`)), timeoutMs);
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort);

  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Stream modes this surface can serve. `events` is deliberately absent: it is not a Pregel stream
 * mode — the run engine serves it from `graph.streamEvents`, while this surface drives `graph.stream`.
 * Accepting it would reduce to an empty `streamMode` array and silently produce no frames, so it is
 * rejected with a 400 pointing at the full protocol instead.
 */
const INVOKE_STREAM_MODES = [
  "values",
  "updates",
  "messages",
  "messages-tuple",
  "custom",
  "debug",
] as const;

const streamModeQuerySchema = z
  .array(z.enum(INVOKE_STREAM_MODES))
  .min(1, "expected at least one stream mode");

/**
 * Per-request `?stream_mode=` override: repeated params or one comma-separated value. Validated at
 * the boundary, so an unknown mode is a 400 rather than an opaque LangGraph fault deeper in.
 */
function streamModeFromQuery(
  value: string | string[] | undefined,
): StreamMode | StreamMode[] | undefined {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : value.split(",");
  const modes = raw.map((mode) => mode.trim()).filter((mode) => mode.length > 0);
  if (modes.length === 0) return undefined;
  if (modes.includes("events")) {
    throw SkeinHttpError.badRequest(
      'Stream mode "events" is not supported on the invoke surface; use the Agent Protocol run ' +
        "endpoints for token-level events.",
    );
  }
  return parse(streamModeQuerySchema, modes, "stream_mode query parameter");
}

/**
 * Build the handler for `POST <prefix>/:graph_id`. Returns a {@link ProtocolHandler}, so every
 * adapter serializes it through the same JSON/SSE path the protocol routes already use.
 */
export function createGraphInvokeHandler(
  deps: ProtocolDeps,
  options: GraphInvokeOptions = {},
): ProtocolHandler {
  return async (req: ProtocolRequest): Promise<ProtocolResponse> => {
    const graphId = requireParam(req.params, "graph_id");

    // Authenticate + authorize exactly as a run does — a graph invocation *is* a run. This runs
    // BEFORE the graph-exists check on purpose: 404-ing an unknown id first would let an
    // unauthenticated caller enumerate which graph ids exist by telling 404 apart from 401.
    let authContext: AuthContext | undefined;
    if (deps.auth) {
      authContext = await resolveAuthContext(deps.auth, req);
      await deps.auth.authorize({
        resource: "threads",
        action: "create_run",
        // `authValue` spreads the body last, and on this surface the body is arbitrary caller-supplied
        // graph input — so a body key named `graph_id` would shadow the path param and let a policy
        // authorize a different graph than the one that actually runs. Re-stamp the server-derived id
        // last so the value a policy judges is always the graph we execute.
        value: { ...authValue(req), graph_id: graphId },
        context: authContext,
      });
    }

    if (!deps.graphs.ids.includes(graphId)) {
      throw SkeinHttpError.notFound(`Graph "${graphId}" is not registered.`, {
        code: "graph_not_found",
      });
    }

    // A fresh saver + thread id per call: graphs that require a checkpointer run, nothing persists.
    const factoryConfigurable = withAuthUser({}, authContext?.user, authContext?.scopes);
    const graph = await resolveCompiledGraph(deps.graphs, graphId, {
      configurable: Object.keys(factoryConfigurable).length > 0 ? factoryConfigurable : undefined,
      checkpointer: new MemorySaver(),
      store: deps.store.store,
    });

    const configurable = withAuthUser(
      { thread_id: randomUUID() },
      authContext?.user,
      authContext?.scopes,
    );
    // The body IS the input — no `{ input }` envelope. An absent body becomes `{}` (run with the
    // state's defaults) rather than `null`, which LangGraph rejects with an opaque `EmptyInputError`;
    // a graph that genuinely needs fields still fails with its own validation error.
    const input = req.body ?? {};

    // Bound the run: `deps.runTimeoutMs` (the same budget the run engine applies) plus the caller's
    // own signal when the adapter supplies one, so a client that disconnects stops the graph instead
    // of leaving it running to completion against nobody.
    const { signal, dispose } = createRunSignal(deps.runTimeoutMs, req.signal);

    if (!wantsEventStream(req)) {
      try {
        const output = await graph.invoke(input, { configurable, signal } as InvokeOptions);
        return { kind: "json", status: 200, body: output };
      } finally {
        dispose();
      }
    }

    const streamMode = toGraphStreamModes(
      streamModeFromQuery(req.query["stream_mode"]) ?? options.streamMode ?? "values",
    );
    // Track the outcome so the synthesized terminal event reports `error` when the graph throws.
    let status: RunStatus = "success";
    const frames = async function* (): AsyncIterable<RunFrame> {
      let seq = 0;
      try {
        const stream = await graph.stream(input, {
          configurable,
          streamMode,
          signal,
        } as StreamOptions);
        for await (const chunk of stream) {
          seq += 1;
          yield toRunFrame(seq, chunkToFrameBody(chunk));
        }
      } catch (error) {
        // Mid-stream failures can't become an HTTP status — headers are already sent — so the error
        // travels as a frame, the same contract the run engine gives streaming clients.
        status = "error";
        seq += 1;
        yield { seq, event: "error", data: serializeError(error) };
      } finally {
        dispose();
      }
    };
    return { kind: "sse", status: 200, events: toSseEvents(frames(), async () => status) };
  };
}
