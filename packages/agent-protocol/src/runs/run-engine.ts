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
import { chunkToFrameBody, toRunFrame } from "../sse/run-frame-stream.js";
import { SkeinBaseStore } from "../store/skein-base-store.js";
import { runStatusForSnapshot, snapshotToThreadUpdate } from "../threads/thread-mirror.js";

import type { RunControl } from "./cancellation.js";
import { toGraphCallOptions, toGraphInput } from "./run-input.js";

/** What the engine needs to execute one run. */
export interface RunExecution {
  run: Run;
  kwargs: RunKwargs;
  control: RunControl;
}

/** The settled result of a run — its terminal status and the graph's final state values. */
export interface RunOutcome {
  status: RunStatus;
  values: DefaultValues;
}

type StreamOptions = Parameters<CompiledGraph<string>["stream"]>[1];

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
      ? await resolved({ configurable: kwargs.config?.configurable })
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

  // Arm the optional wall-clock timeout; it aborts this run's signal with reason "timeout".
  const timer =
    deps.runTimeoutMs !== undefined
      ? setTimeout(() => control.abort("timeout"), deps.runTimeoutMs)
      : undefined;

  try {
    // Cancelled before we even started (e.g. the worker was slow to pick it up): honor it.
    const current = await deps.store.runs.get(runId);
    if (current && isTerminalRunStatus(current.status)) {
      return { status: current.status, values: {} as DefaultValues };
    }

    // pending -> running: run row first (the concurrency source of truth), then the thread mirror.
    await deps.store.runs.setStatus(runId, "running");
    await mirrorThreadStatus(deps, threadId, "busy");

    const assistant = await deps.store.assistants.get(run.assistant_id);
    if (!assistant) {
      throw SkeinHttpError.notFound(`Assistant "${run.assistant_id}" not found.`);
    }

    const graph = await resolveGraph(deps, assistant.graph_id, kwargs);
    const input = toGraphInput(kwargs);
    const options = toGraphCallOptions(kwargs, threadId, control.signal);

    const stream = await graph.stream(input, options as unknown as StreamOptions);
    for await (const chunk of stream) {
      seq += 1;
      await deps.bus.publish(runId, toRunFrame(seq, chunkToFrameBody(chunk)));
    }

    // A cancel/timeout may have raced in while the graph was finishing (an uninterruptible node can
    // complete despite the abort). Honor the abort over a success result so the stored status, the
    // returned outcome, and the client's cancel/timeout all agree.
    if (control.signal.aborted) {
      const timedOut = control.reason.current === "timeout";
      const finalStatus = await finalizeRun(deps, runId, timedOut ? "timeout" : "error");
      if (finalStatus === "timeout") await mirrorThreadError(deps, threadId, "Run timed out.");
      else if (finalStatus === "error") await mirrorThreadStatus(deps, threadId, "idle");
      return { status: finalStatus, values: {} as DefaultValues };
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
    return { status: finalStatus, values: snapshot.values as DefaultValues };
  } catch (error) {
    const reason = control.reason.current;
    if (reason === "timeout") {
      const finalStatus = await finalizeRun(deps, runId, "timeout");
      if (finalStatus === "timeout") await mirrorThreadError(deps, threadId, "Run timed out.");
      return { status: finalStatus, values: {} as DefaultValues };
    }
    if (reason === "cancel" || control.signal.aborted) {
      // A cancelled run is a terminal error, but the thread is free again (idle).
      const finalStatus = await finalizeRun(deps, runId, "error");
      if (finalStatus === "error") await mirrorThreadStatus(deps, threadId, "idle");
      return { status: finalStatus, values: {} as DefaultValues };
    }
    // Genuine graph error: surface it as the terminal frame, then persist error state.
    const serialized = serializeError(error);
    seq += 1;
    await deps.bus.publish(runId, { seq, event: "error", data: serialized });
    const finalStatus = await finalizeRun(deps, runId, "error");
    if (finalStatus === "error") await mirrorThreadError(deps, threadId, serialized.message);
    return { status: finalStatus, values: {} as DefaultValues };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Always close the bus so every subscriber's iterator completes and emits the terminal event.
    await deps.bus.close(runId);
  }
}
