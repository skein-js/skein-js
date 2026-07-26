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
  runError,
  SkeinHttpError,
  toRunError,
  type DefaultValues,
  type Metadata,
  type Run,
  type RunError,
  type RunKwargs,
  type RunStatus,
  type ThreadStatus,
  type ThreadUpdate,
} from "@skein-js/core";

import { isNoopLogger, type ResolvedDeps } from "../deps.js";
import { resolveCompiledGraph } from "../graphs/resolve-compiled-graph.js";
import {
  chunkToFrameBody,
  streamEventToFrameBody,
  toRunFrame,
  type GraphStreamEvent,
} from "../sse/run-frame-stream.js";
import { runStatusForSnapshot, snapshotToThreadUpdate } from "../threads/thread-mirror.js";

import type { AbortReason, RunControl } from "./cancellation.js";
import { RUN_FAILURE_REPORT_KIND, toError, type RunFailureReport } from "./run-failure.js";
import {
  toFactoryConfigurable,
  toGraphCallOptions,
  toGraphInput,
  toGraphStreamModes,
  wantsEventsMode,
} from "./run-input.js";
import { describeFailingNodes, describeInterrupts, extractToolActivity } from "./run-log.js";

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

/**
 * Why a timed-out run stopped. Persisted like any other failure so `timeout` — the one terminal
 * status that isn't the graph's fault — is still explainable from the run row alone.
 */
const RUN_TIMEOUT_ERROR: RunError = runError("TimeoutError", "Run timed out.");

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
  /**
   * Why the run failed, for a `error`/`timeout` status. The same payload published on the `error`
   * frame and persisted on the run row, so a caller that never subscribed (wait, the background
   * worker) can still report the failure.
   */
  error?: RunError;
}

type StreamOptions = Parameters<CompiledGraph<string>["stream"]>[1];
type StreamEventsOptions = Parameters<CompiledGraph<string>["streamEvents"]>[1];

/**
 * Resolve an assistant's graph for this run. Delegates to the shared resolver (which attaches the
 * checkpointer and long-term store); the run-specific part is exposing the authenticated caller to a
 * graph *factory*, so a factory that branches on the principal sees the same `langgraph_auth_user` a
 * node reads — sanitized identically, so a client can't spoof it via its own configurable.
 */
async function resolveGraph(
  deps: ResolvedDeps,
  graphId: string,
  kwargs: RunKwargs,
): Promise<CompiledGraph<string>> {
  return resolveCompiledGraph(deps.graphs, graphId, {
    configurable: toFactoryConfigurable(kwargs),
    checkpointer: deps.checkpointer,
    store: deps.store.store,
  });
}

/**
 * Set a run's status only if it hasn't already reached a terminal state; returns the effective
 * status. `error` travels with the status in the same single write, so a run row is never briefly
 * readable as failed-with-no-reason, and a racing cancel can't end up wearing this run's error.
 */
async function finalizeRun(
  deps: ResolvedDeps,
  runId: string,
  status: RunStatus,
  error?: RunError,
): Promise<RunStatus> {
  const fresh = await deps.store.runs.get(runId);
  if (!fresh) return status; // deleted mid-run (e.g. its thread was removed)
  if (isTerminalRunStatus(fresh.status)) return fresh.status; // cancel/timeout already won
  await deps.store.runs.setStatus(runId, status, error);
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
  // When leaving the error state, drop a stale error left behind by a prior failed run, so a
  // now-healthy thread doesn't keep reporting an old message. Note this clearing is why the thread
  // is only a mirror of the *latest* turn — the durable per-run record is `Run.error`.
  let effective = patch;
  if (patch.status && patch.status !== "error") {
    effective = { ...patch, error: null };
    // (The patch's own metadata wins if it brought one.)
    if (patch.metadata === undefined && thread.metadata != null && "error" in thread.metadata) {
      const cleared: Metadata = { ...thread.metadata };
      delete cleared["error"];
      effective = { ...effective, metadata: cleared };
    }
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

/**
 * Mirror a failed run onto the thread: status `error`, carrying the message in two places. `error`
 * is the SDK's own `Thread.error` field, which is where a client looks; `metadata.error` is skein's
 * older home for it, kept so existing readers don't break. Both are cleared by `mirrorThread` when
 * the thread recovers — the durable per-run record is `Run.error`.
 */
async function mirrorThreadError(
  deps: ResolvedDeps,
  threadId: string,
  message: string,
): Promise<void> {
  const thread = await deps.store.threads.get(threadId);
  if (!thread) return;
  const metadata: Metadata = { ...thread.metadata, error: message };
  await deps.store.threads.update(threadId, { status: "error", metadata, error: message });
}

/**
 * Name the node(s) the graph died in, for the failure report. Entirely best-effort: it re-reads the
 * state after the throw, and a graph that failed before it started (or whose state read also fails)
 * simply yields nothing. Reporting must never turn one failure into two.
 */
async function readFailingNodes(
  graph: CompiledGraph<string> | undefined,
  threadId: string,
): Promise<string[]> {
  if (!graph) return [];
  try {
    const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
    return describeFailingNodes(snapshot);
  } catch {
    return [];
  }
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
  // Hoisted out of the `try` so the catch can take a post-mortem snapshot to name the failing node.
  let graph: CompiledGraph<string> | undefined;

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

    graph = await resolveGraph(deps, assistant.graph_id, kwargs);
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
      const abortStatus = abortedStatus(control.reason.current);
      const timedOut = abortStatus === "timeout" ? RUN_TIMEOUT_ERROR : undefined;
      const finalStatus = await finalizeRun(deps, runId, abortStatus, timedOut);
      if (finalStatus === "timeout")
        await mirrorThreadError(deps, threadId, RUN_TIMEOUT_ERROR.message);
      else await mirrorThreadStatus(deps, threadId, "idle");
      logFinished(finalStatus);
      outcome = {
        status: finalStatus,
        values: {} as DefaultValues,
        ...(timedOut ? { error: timedOut } : {}),
      };
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
      const finalStatus = await finalizeRun(deps, runId, "timeout", RUN_TIMEOUT_ERROR);
      if (finalStatus === "timeout")
        await mirrorThreadError(deps, threadId, RUN_TIMEOUT_ERROR.message);
      logFinished(finalStatus);
      outcome = { status: finalStatus, values: {} as DefaultValues, error: RUN_TIMEOUT_ERROR };
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
    // Genuine graph error: surface it as the terminal frame, then persist error state. One payload
    // serves the frame, the run row, and the returned outcome, so they can never disagree.
    const wireError = toRunError(error, { includeStack: deps.exposeErrorStacks === true });
    seq += 1;
    await deps.bus.publish(runId, { seq, event: "error", data: wireError });
    const finalStatus = await finalizeRun(deps, runId, "error", wireError);
    if (finalStatus === "error") await mirrorThreadError(deps, threadId, wireError.message);
    // ALWAYS logged, ungated by `logRunActivity`: a run that fails silently is the whole problem
    // this reporting exists to solve. The report carries the original Error, so a console logger can
    // render its stack and `cause` chain.
    //
    // Assembling it is skipped entirely for the discarding default logger, because naming the node
    // that threw costs a checkpointer read — a network round trip in production. Paying that to
    // build an object nobody reads is waste on a path that has already gone wrong.
    if (!isNoopLogger(deps.logger)) {
      const failingNodes = await readFailingNodes(graph, threadId);
      deps.logger.error(`Graph run failed: ${wireError.message}`, {
        kind: RUN_FAILURE_REPORT_KIND,
        runId,
        threadId,
        assistantId: run.assistant_id,
        failingNodes,
        error: toError(error),
        wireError,
      } satisfies RunFailureReport);
    }
    logFinished(finalStatus);
    webhookErrorMessage = wireError.message;
    outcome = { status: finalStatus, values: {} as DefaultValues, error: wireError };
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
