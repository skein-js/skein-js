// The run engine. Given a run row and its stored kwargs, it drives the LangGraph graph to
// completion, publishing every stream chunk as a `RunFrame` on the bus and owning *all* run/thread
// status writes. It is the single execution path for every run mode — wait awaits the returned
// outcome, stream subscribes to the bus while this runs, background invokes it from a worker.
//
// Reliability rests on two rules:
//   1. Status writes are ordered run-row-first, so the concurrency guard releases before the
//      (cosmetic) thread mirror, and a crash between them self-heals on the next run.
//   2. The engine never overwrites an already-terminal run row (`finalizeRun` re-reads first).
//      So whichever of {engine finishes, cancel/timeout fires} lands first wins; the other no-ops.
// The `finally` block always closes the bus, so every subscriber's stream terminates.

import type { CompiledGraph, StateSnapshot } from "@langchain/langgraph";
import {
  isTerminalRunStatus,
  SkeinHttpError,
  type DefaultValues,
  type Metadata,
  type Run,
  type RunKwargs,
  type RunStatus,
  type ThreadStatus,
  type ThreadUpdate,
} from "@skein-js/core";

import type { ResolvedDeps } from "../deps.js";
import { serializeError } from "../normalize-error.js";
import {
  chunkToFrameBody,
  streamEventToFrameBody,
  toRunFrame,
  type GraphStreamEvent,
} from "../sse/run-frame-stream.js";
import { SkeinBaseStore } from "../store/skein-base-store.js";
import { runStatusForSnapshot, snapshotToThreadUpdate } from "../threads/thread-mirror.js";

import type { AbortReason, RunControl } from "./cancellation.js";
import {
  toFactoryConfigurable,
  toGraphCallOptions,
  toGraphInput,
  toGraphStreamModes,
  wantsEventsMode,
} from "./run-input.js";
import { describeInterrupts, extractToolActivity } from "./run-log.js";

/** What the engine needs to execute one run. */
export interface RunExecution {
  run: Run;
  kwargs: RunKwargs;
  control: RunControl;
  /**
   * Called once at `pending -> running` with the thread's checkpoint tip at that moment (`undefined`
   * if none). The run service uses this to compute a `rollback` plan for a run that later displaces
   * this one. Optional so tests can omit it.
   */
  recordBaseCheckpoint?: (baseCheckpointId: string | undefined) => void;
}

/** Map an abort reason to the run's terminal status. `interrupt` keeps work; the rest are stops. */
function abortedStatus(reason: AbortReason | null): RunStatus {
  if (reason === "timeout") return "timeout";
  if (reason === "interrupt") return "interrupted";
  return "cancelled"; // "cancel", "rollback", or an aborted signal with no recorded reason
}

/** The settled result of a run — its terminal status and the graph's final state values. */
export interface RunOutcome {
  status: RunStatus;
  values: DefaultValues;
}

type StreamOptions = Parameters<CompiledGraph<string>["stream"]>[1];
type StreamEventsOptions = Parameters<CompiledGraph<string>["streamEvents"]>[1];

/**
 * Resolve an assistant's graph, invoking a factory export with the run's configurable, then attach
 * the injected checkpointer (thread state, history, interrupt/resume) and the long-term store
 * (cross-thread memory via `getStore()`). Both mirror how `@langchain/langgraph-api` injects its
 * saver and store onto the compiled graph, so a graph written for LangGraph Platform runs unchanged.
 */
async function resolveGraph(
  deps: ResolvedDeps,
  graphId: string,
  kwargs: RunKwargs,
): Promise<CompiledGraph<string>> {
  const resolved = await deps.graphs.load(graphId);
  const graph =
    typeof resolved === "function"
      ? // Expose the authenticated caller to a graph *factory* too, so a factory that branches on the
        // principal sees the same `langgraph_auth_user` a node reads — sanitized identically, so a
        // client can't spoof it via its own configurable.
        await resolved({ configurable: toFactoryConfigurable(kwargs) })
      : resolved;
  (graph as { checkpointer?: unknown }).checkpointer = deps.checkpointer;
  (graph as { store?: unknown }).store = new SkeinBaseStore(deps.store.store);
  return graph;
}

/** Set a run's status only if it hasn't already reached a terminal state; returns the effective status. */
async function finalizeRun(
  deps: ResolvedDeps,
  runId: string,
  status: RunStatus,
): Promise<RunStatus> {
  const fresh = await deps.store.runs.get(runId);
  if (!fresh) return status; // deleted mid-run (e.g. its thread was removed)
  if (isTerminalRunStatus(fresh.status)) return fresh.status; // cancel/timeout already won
  await deps.store.runs.setStatus(runId, status);
  return status;
}

// All thread mirroring goes through here: it reads first and skips if the thread is gone, so a run
// whose thread was deleted mid-flight can't throw a 404 from inside the engine.
async function mirrorThread(
  deps: ResolvedDeps,
  threadId: string,
  patch: ThreadUpdate,
): Promise<void> {
  const thread = await deps.store.threads.get(threadId);
  if (!thread) return;
  // When leaving the error state, drop a stale `error` left in metadata by a prior failed run, so a
  // now-healthy thread doesn't keep reporting an old message. (The patch's own metadata wins.)
  let effective = patch;
  if (
    patch.status &&
    patch.status !== "error" &&
    patch.metadata === undefined &&
    thread.metadata != null &&
    "error" in thread.metadata
  ) {
    const cleared: Metadata = { ...thread.metadata };
    delete cleared["error"];
    effective = { ...patch, metadata: cleared };
  }
  await deps.store.threads.update(threadId, effective);
}

async function mirrorThreadStatus(
  deps: ResolvedDeps,
  threadId: string,
  status: ThreadStatus,
): Promise<void> {
  await mirrorThread(deps, threadId, { status });
}

/** Mirror a failed run onto the thread: status `error`, with the message kept in metadata. */
async function mirrorThreadError(
  deps: ResolvedDeps,
  threadId: string,
  message: string,
): Promise<void> {
  const thread = await deps.store.threads.get(threadId);
  if (!thread) return;
  const metadata: Metadata = { ...thread.metadata, error: message };
  await deps.store.threads.update(threadId, { status: "error", metadata });
}

/**
 * Execute a run to a terminal status, publishing frames as it goes. Resolves once the run has
 * settled and the bus is closed. Never rejects for a graph error — that becomes an `error` frame
 * and an `error` outcome; it only throws for a programming/precondition failure before streaming.
 */
export async function executeRun(deps: ResolvedDeps, exec: RunExecution): Promise<RunOutcome> {
  const { run, kwargs, control } = exec;
  const runId = run.run_id;
  const threadId = run.thread_id;
  let seq = 0;
  // Captured for the run-completion webhook fired in `finally`. `started` gates the webhook to runs
  // that actually executed (a run cancelled while still pending never fires one, matching the worker).
  let started = false;
  let outcome: RunOutcome = { status: "error", values: {} as DefaultValues };
  let webhookErrorMessage: string | undefined;

  // Verbose run activity (start/finish, tool calls, interrupts) — `skein dev --verbose`. Guarded so
  // it costs nothing when off. Tool calls/results are logged once each; streaming repeats the same
  // call across chunks, so we dedupe on the tool-call id (falling back to the name).
  const startedAt = deps.clock().getTime();
  const loggedTools = new Set<string>();
  const logToolActivity = (data: unknown): void => {
    const { calls, results } = extractToolActivity(data);
    for (const call of calls) {
      const key = `call:${call.id ?? call.name}`;
      if (loggedTools.has(key)) continue;
      loggedTools.add(key);
      deps.logger.info(`run ${runId} → tool call: ${call.name}`);
    }
    for (const result of results) {
      const key = `result:${result.id ?? result.name}`;
      if (loggedTools.has(key)) continue;
      loggedTools.add(key);
      deps.logger.info(`run ${runId} ← tool result: ${result.name}`);
    }
  };
  const logFinished = (status: RunStatus): void => {
    if (!deps.logRunActivity) return;
    deps.logger.info(
      `run ${runId} ${status} in ${deps.clock().getTime() - startedAt}ms (${seq} frames)`,
    );
  };

  // Arm the optional wall-clock timeout; it aborts this run's signal with reason "timeout".
  const timer =
    deps.runTimeoutMs !== undefined
      ? setTimeout(() => control.abort("timeout"), deps.runTimeoutMs)
      : undefined;

  try {
    // Cancelled before we even started (e.g. the worker was slow to pick it up): honor it.
    const current = await deps.store.runs.get(runId);
    if (current && isTerminalRunStatus(current.status)) {
      outcome = { status: current.status, values: {} as DefaultValues };
      return outcome;
    }

    // pending -> running: run row first (the concurrency source of truth), then the thread mirror.
    await deps.store.runs.setStatus(runId, "running");
    started = true;
    await mirrorThreadStatus(deps, threadId, "busy");
    // Record the thread's checkpoint tip *before* this run writes anything, so a later `rollback` run
    // knows the state to revert to. Only record on a *successful* read: a genuine `undefined` (fresh
    // thread, no checkpoints) means "revert to empty", but a failed read is *unknown* — recording
    // `undefined` there would make a later rollback wipe the thread's real prior history. On failure
    // we record nothing, so rollback safely skips the checkpoint revert. Best-effort either way.
    if (exec.recordBaseCheckpoint) {
      try {
        const tip = await deps.checkpointer.getTuple({ configurable: { thread_id: threadId } });
        exec.recordBaseCheckpoint(tip?.checkpoint.id);
      } catch (error) {
        deps.logger.warn(
          `run ${runId}: failed to read base checkpoint; a rollback of this run won't revert checkpoints`,
          error,
        );
      }
    }
    if (deps.logRunActivity) {
      deps.logger.info(`run ${runId} started · assistant=${run.assistant_id} thread=${threadId}`);
    }

    const assistant = await deps.store.assistants.get(run.assistant_id);
    if (!assistant) {
      throw SkeinHttpError.notFound(`Assistant "${run.assistant_id}" not found.`);
    }

    const graph = await resolveGraph(deps, assistant.graph_id, kwargs);
    const input = toGraphInput(kwargs);
    const options = toGraphCallOptions(kwargs, threadId, control.signal);

    if (wantsEventsMode(kwargs.stream_mode)) {
      // True `events` mode: drive the graph via `streamEvents` and demux each event — internal
      // `on_chain_stream` chunks become mode frames, everything else becomes an `events` frame.
      // `runId` tags the root run so the demux can tell this run's stream chunks from a subgraph's.
      const graphModes = toGraphStreamModes(kwargs.stream_mode);
      const eventStream = graph.streamEvents(input, {
        ...options,
        version: "v2",
        runId,
      } as unknown as StreamEventsOptions) as unknown as AsyncIterable<GraphStreamEvent>;
      for await (const event of eventStream) {
        const body = streamEventToFrameBody(event, runId, graphModes);
        if (!body) continue;
        seq += 1;
        await deps.bus.publish(runId, toRunFrame(seq, body));
        if (deps.logRunActivity) logToolActivity(body.data);
      }
    } else {
      const stream = await graph.stream(input, options as unknown as StreamOptions);
      for await (const chunk of stream) {
        seq += 1;
        const body = chunkToFrameBody(chunk);
        await deps.bus.publish(runId, toRunFrame(seq, body));
        if (deps.logRunActivity) logToolActivity(body.data);
      }
    }

    // A cancel/timeout/interrupt/rollback may have raced in while the graph was finishing (an
    // uninterruptible node can complete despite the abort). Honor the abort over a success result so
    // the stored status, the returned outcome, and the client's request all agree.
    if (control.signal.aborted) {
      const finalStatus = await finalizeRun(deps, runId, abortedStatus(control.reason.current));
      if (finalStatus === "timeout") await mirrorThreadError(deps, threadId, "Run timed out.");
      else await mirrorThreadStatus(deps, threadId, "idle");
      logFinished(finalStatus);
      outcome = { status: finalStatus, values: {} as DefaultValues };
      return outcome;
    }

    // Classify from the authoritative snapshot, not the stream: paused -> interrupted, else success.
    const snapshot: StateSnapshot = await graph.getState({ configurable: { thread_id: threadId } });
    const computed = runStatusForSnapshot(snapshot);
    const finalStatus = await finalizeRun(deps, runId, computed);
    if (finalStatus === computed) {
      await mirrorThread(deps, threadId, snapshotToThreadUpdate(snapshot, finalStatus));
    } else {
      await mirrorThreadStatus(deps, threadId, finalStatus === "error" ? "error" : "idle");
    }
    if (deps.logRunActivity && finalStatus === "interrupted") {
      const prompts = describeInterrupts(snapshot);
      deps.logger.info(
        `run ${runId} interrupted${prompts.length ? ` · awaiting: ${prompts.join("; ")}` : ""}`,
      );
    }
    logFinished(finalStatus);
    outcome = { status: finalStatus, values: snapshot.values as DefaultValues };
    return outcome;
  } catch (error) {
    const reason = control.reason.current;
    if (reason === "timeout") {
      const finalStatus = await finalizeRun(deps, runId, "timeout");
      if (finalStatus === "timeout") await mirrorThreadError(deps, threadId, "Run timed out.");
      logFinished(finalStatus);
      outcome = { status: finalStatus, values: {} as DefaultValues };
      return outcome;
    }
    if (
      reason === "cancel" ||
      reason === "interrupt" ||
      reason === "rollback" ||
      control.signal.aborted
    ) {
      // Displaced (interrupt/rollback) or explicitly cancelled: terminal in its own right, and the
      // thread is free again (idle). `interrupt` keeps its checkpoints; a `rollback` run drops them.
      const finalStatus = await finalizeRun(deps, runId, abortedStatus(reason));
      await mirrorThreadStatus(deps, threadId, "idle");
      logFinished(finalStatus);
      outcome = { status: finalStatus, values: {} as DefaultValues };
      return outcome;
    }
    // Genuine graph error: surface it as the terminal frame, then persist error state.
    const serialized = serializeError(error);
    seq += 1;
    await deps.bus.publish(runId, { seq, event: "error", data: serialized });
    const finalStatus = await finalizeRun(deps, runId, "error");
    if (finalStatus === "error") await mirrorThreadError(deps, threadId, serialized.message);
    if (deps.logRunActivity) deps.logger.error(`run ${runId} error: ${serialized.message}`);
    logFinished(finalStatus);
    webhookErrorMessage = serialized.message;
    outcome = { status: finalStatus, values: {} as DefaultValues };
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Always close the bus so every subscriber's iterator completes and emits the terminal event.
    await deps.bus.close(runId);
    // Run-completion webhook: fire once, best-effort, only for a run that actually executed. A
    // delivery failure is logged, never propagated — it must not fail or delay the run.
    if (started && kwargs.webhook !== undefined) {
      const sentAt = deps.clock().toISOString();
      const payload = {
        ...run,
        status: outcome.status,
        values: outcome.values,
        run_started_at: new Date(startedAt).toISOString(),
        run_ended_at: sentAt,
        webhook_sent_at: sentAt,
        ...(webhookErrorMessage !== undefined ? { error: webhookErrorMessage } : {}),
      };
      try {
        await deps.webhookDispatcher(kwargs.webhook, payload);
      } catch (error) {
        deps.logger.warn(`run ${runId}: webhook delivery to ${kwargs.webhook} failed`, error);
      }
    }
  }
}
