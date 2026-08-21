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

import {
  isTerminalRunStatus,
  runError,
  SkeinHttpError,
  toRunError,
  type DefaultValues,
  type Interrupt,
  type Delivery,
  type Metadata,
  type Run,
  type RunError,
  type RunKwargs,
  type RunStatus,
  type RunTelemetryContext,
  type RunTrigger,
  type ThreadStatus,
  type ThreadUpdate,
} from "@skein-js/core";

import { attemptDelivery } from "../deliveries/attempt-delivery.js";
import { DEFAULT_RETAIN_HOURS, deliveryLeaseMs } from "../deliveries/delivery-config.js";
import { buildDeliveryPayload } from "../deliveries/delivery-payload.js";
import { redactWebhookUrl } from "../deliveries/delivery-target.js";
import { isNoopLogger, webhookTimeoutMs, type ResolvedDeps } from "../deps.js";
import {
  requireAgentCapability,
  type AgentGraph,
  type AgentStateSnapshot,
} from "../graphs/agent-graph.js";
import { resolveCompiledGraph } from "../graphs/resolve-compiled-graph.js";
import {
  chunkToFrameBody,
  streamEventToFrameBody,
  toRunFrame,
  type GraphStreamEvent,
  type RunFrameBody,
} from "../sse/run-frame-stream.js";
import {
  collectInterrupts,
  runStatusForSnapshot,
  snapshotToThreadUpdate,
} from "../threads/thread-mirror.js";

import type { AbortReason, RunControl } from "./cancellation.js";
import { readDeclaredReply } from "./declared-reply.js";
import { RUN_FAILURE_REPORT_KIND, toError, type RunFailureReport } from "./run-failure.js";
import {
  toFactoryConfigurable,
  toGraphCallOptions,
  toGraphInput,
  toGraphStreamModes,
  wantsEventsMode,
} from "./run-input.js";
import { describeFailingNodes, describeInterrupts, extractToolActivity } from "./run-log.js";
import {
  emitRunEvent,
  telemetryCallOptions,
  toRunTelemetryContext,
  withRunTelemetryContext,
} from "./run-telemetry.js";

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
  /**
   * How this run was started, for telemetry. Defaults to `"wait"` — the inline, non-streaming shape —
   * so a caller that doesn't care (and every existing test) needn't say.
   */
  trigger?: RunTrigger;
  /**
   * When the run was enqueued, as epoch ms, so telemetry can report how long it waited for a worker.
   * Background runs only; inline runs never queue.
   */
  queuedAtMs?: number;
  /**
   * Receives the run-completion webhook delivery instead of it being awaited here.
   *
   * The engine's `finally` runs inside the thread's execution lock, so awaiting a slow or hung webhook
   * target there blocks every other run on that thread and keeps the run's whole final state alive
   * meanwhile. `startRunExecution` passes this and awaits the delivery once the lock has released.
   *
   * Omitted → delivered inline, which is what a direct caller (and every test that drives the engine
   * on its own) wants.
   */
  deferWebhook?: (deliver: () => Promise<void>) => void;
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
  /**
   * The questions a run that ended `interrupted` is waiting on, keyed by task.
   *
   * Part of the outcome rather than read back afterwards because the snapshot holding them is only in
   * scope while the run settles — and because a second read could observe a thread that has since
   * moved on.
   */
  interrupts?: Record<string, Interrupt[]>;
  /** What the graph declared should be sent back, via `replyWith` on the custom stream. */
  reply?: unknown;
}

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
): Promise<AgentGraph> {
  return resolveCompiledGraph(deps.graphs, graphId, {
    configurable: toFactoryConfigurable(kwargs),
    checkpointer: deps.checkpointer,
    store: deps.storeBridge?.(deps.store.store),
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
  graph: AgentGraph | undefined,
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
  // The reply the graph declared on the custom stream, if any. Held here rather than read back off the
  // bus at delivery time: bus frames live in memory and are never persisted, so a crash between the run
  // settling and the callback going out would lose the answer — the one thing the outbox must not lose.
  // Last write wins; a run has one answer.
  let declaredReply: { reply: unknown } | undefined;
  const captureDeclaredReply = (body: RunFrameBody): void => {
    const found = readDeclaredReply(body.data);
    if (found) declaredReply = found;
  };
  // Hoisted out of the `try` so the catch can take a post-mortem snapshot to name the failing node.
  let graph: AgentGraph | undefined;
  // Telemetry, all hoisted so the `finally` can close the span the `try` opened. The context needs
  // the assistant's graph id, so it only exists once the assistant has loaded — and `run.finished`
  // is gated on it, so the two events are always emitted as a pair. A run that fails its
  // preconditions (a deleted assistant) never ran a graph and reports no span; it is still logged
  // as a failure and still recorded on the run row.
  let telemetryContext: RunTelemetryContext | undefined;
  let failingNodes: readonly string[] | undefined;
  let thrownError: Error | undefined;

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

  // The delivery this run's terminal status was committed alongside, when there was one to commit.
  // Read by the `finally`, which attempts it once the run has settled.
  let recordedDelivery: Delivery | undefined;

  /**
   * Finalize the run — and, when it owes a callback, record that callback in the *same* write.
   *
   * This is `finalizeRun` plus the outbox, and it replaces it at every terminal site. The two halves
   * commit together or not at all, which is the whole point: a crash between "the run succeeded" and
   * "someone was told" is exactly the window a webhook cannot survive today, and it sits before any
   * injected dispatcher runs, so no caller can close it for themselves.
   *
   * Returns the *effective* status, exactly as `finalizeRun` does — which for a run a cancel already
   * won is the cancel's, not the one we asked for. It reads that back off the delivery rather than
   * recomputing it, so the row and the callback can never disagree about how the run ended.
   */
  const settleRun = async (
    status: RunStatus,
    settled: {
      values: DefaultValues;
      error?: RunError;
      /** Pending interrupts, for a run that parked on one. See `BuildDeliveryPayloadInput`. */
      interrupts?: Record<string, Interrupt[]>;
      /** The graph's declared reply, if it wrote one. See `BuildDeliveryPayloadInput`. */
      reply?: unknown;
    },
  ): Promise<RunStatus> => {
    const recordDelivery = deps.store.runs.finalizeWithDelivery;
    // No webhook, no outbox in this driver, or a run that never executed: the pre-outbox path, which
    // for the last case means no callback at all — matching today, where `started` gates the fire.
    //
    // `recordedDelivery` is the third guard and the least obvious: this function can be reached
    // twice. Anything after the first `settleRun` — `mirrorThread`'s write, most likely — can throw,
    // and the catch settles the run again. The status write is idempotent (the second one finds a
    // terminal row and leaves it), but the delivery insert is deliberately *unconditional*, so a
    // second pass would record a second callback with a different id — two notifications for one run,
    // one of them announcing a success that never happened, and the dedup key useless against them
    // because the ids differ.
    if (
      !started ||
      kwargs.webhook === undefined ||
      !deps.store.deliveries ||
      !recordDelivery ||
      recordedDelivery !== undefined
    ) {
      return finalizeRun(deps, runId, status, settled.error);
    }
    const endedAt = deps.clock();
    // Guarded because it serializes: a final state carrying a BigInt or a cycle throws here, and this
    // now runs *before* the run's status is written. Unguarded, a graph that returned an awkward value
    // would have its successful run recorded as `error` — the callback machinery deciding the run's
    // outcome, which it must never do. Falling back to the plain finalize costs the callback and keeps
    // the run honest; `buildDeliveryPayload` already substitutes a marker for the common cases.
    let built: ReturnType<typeof buildDeliveryPayload>;
    try {
      built = buildDeliveryPayload({
        run,
        values: settled.values,
        runStartedAt: new Date(startedAt).toISOString(),
        runEndedAt: endedAt.toISOString(),
        ...(settled.error ? { error: settled.error.message } : {}),
        ...(settled.interrupts ? { interrupts: settled.interrupts } : {}),
        ...(settled.reply !== undefined ? { reply: settled.reply } : {}),
        ...(deps.webhooks?.maxPayloadBytes !== undefined
          ? { maxPayloadBytes: deps.webhooks.maxPayloadBytes }
          : {}),
      });
    } catch (error) {
      deps.logger.error(
        `run ${runId}: its webhook payload could not be serialized, so no callback was recorded`,
        error,
      );
      return finalizeRun(deps, runId, status, settled.error);
    }
    const { payload, truncated, bytes } = built;
    if (truncated) {
      // Warned on every truncation, not once per process: a receiver silently losing `values` is a
      // shape change it cannot detect from the outside, and one log line at boot would not connect
      // it to the run it happened to.
      deps.logger.warn(
        `run ${runId}: webhook payload was ${bytes} bytes; \`values\` replaced by a truncation marker`,
      );
    }
    const { delivery } = await recordDelivery.call(deps.store.runs, runId, {
      status,
      ...(settled.error ? { error: settled.error } : {}),
      delivery: {
        thread_id: threadId,
        url: kwargs.webhook,
        payload,
        payload_truncated: truncated,
        // Born claimed for the inline attempt below; if this process dies before recording its
        // outcome, the lease expires and a worker takes it over.
        // A batch of one: the engine makes exactly one inline attempt before handing over.
        next_attempt_at: new Date(
          endedAt.getTime() + deliveryLeaseMs(1, webhookTimeoutMs()),
        ).toISOString(),
        expires_at: new Date(
          endedAt.getTime() + (deps.webhooks?.retainHours ?? DEFAULT_RETAIN_HOURS) * 3_600_000,
        ).toISOString(),
      },
    });
    recordedDelivery = delivery;
    return delivery.run_status;
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

    if (deps.telemetryEnabled) {
      telemetryContext = toRunTelemetryContext(
        run,
        kwargs,
        assistant.graph_id,
        exec.trigger ?? "wait",
      );
      emitRunEvent(deps, {
        type: "run.started",
        context: telemetryContext,
        startedAt: new Date(startedAt),
        ...(exec.queuedAtMs !== undefined ? { queuedMs: startedAt - exec.queuedAtMs } : {}),
      });
    }

    graph = await resolveGraph(deps, assistant.graph_id, kwargs);
    const activeGraph = graph;
    const input = toGraphInput(kwargs);
    // Trace identity (metadata/tags/runName) and any tracer handlers ride along with the call, so a
    // callback-based tracer's spans nest under this run instead of floating free. Empty when no
    // sink is configured.
    const options = {
      ...toGraphCallOptions(kwargs, threadId, control.signal),
      ...(telemetryContext ? telemetryCallOptions(deps, telemetryContext) : {}),
    };

    await withRunTelemetryContext(deps, telemetryContext, async () => {
      if (wantsEventsMode(kwargs.stream_mode)) {
        // True `events` mode: drive the graph via `streamEvents` and demux each event — internal
        // `on_chain_stream` chunks become mode frames, everything else becomes an `events` frame.
        // `runId` tags the root run so the demux can tell this run's stream chunks from a subgraph's.
        const graphModes = toGraphStreamModes(kwargs.stream_mode);
        // `events` mode needs `streamEvents`; an agent without it gets a handled 422 rather
        // than an unhandled TypeError. LangGraph always implements it.
        const eventStream = requireAgentCapability(activeGraph, "streamEvents").streamEvents(
          input,
          {
            ...options,
            version: "v2",
            runId,
          },
        ) as AsyncIterable<GraphStreamEvent>;
        for await (const event of eventStream) {
          const body = streamEventToFrameBody(event, runId, graphModes);
          if (!body) continue;
          seq += 1;
          captureDeclaredReply(body);
          await deps.bus.publish(runId, toRunFrame(seq, body));
          if (deps.logRunActivity) logToolActivity(body.data);
        }
      } else {
        const stream = await activeGraph.stream(input, options);
        for await (const chunk of stream) {
          seq += 1;
          const body = chunkToFrameBody(chunk);
          captureDeclaredReply(body);
          await deps.bus.publish(runId, toRunFrame(seq, body));
          if (deps.logRunActivity) logToolActivity(body.data);
        }
      }
    });

    // A cancel/timeout/interrupt/rollback may have raced in while the graph was finishing (an
    // uninterruptible node can complete despite the abort). Honor the abort over a success result so
    // the stored status, the returned outcome, and the client's request all agree.
    if (control.signal.aborted) {
      const abortStatus = abortedStatus(control.reason.current);
      const timedOut = abortStatus === "timeout" ? RUN_TIMEOUT_ERROR : undefined;
      const finalStatus = await settleRun(abortStatus, {
        values: {} as DefaultValues,
        ...(timedOut ? { error: timedOut } : {}),
      });
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
    const snapshot: AgentStateSnapshot = await activeGraph.getState({
      configurable: { thread_id: threadId },
    });
    const computed = runStatusForSnapshot(snapshot);
    // The snapshot is already in hand, so the questions cost nothing extra to carry — no second read
    // of the thread, and no window in which the run settles before they are captured.
    const finalStatus = await settleRun(computed, {
      values: snapshot.values as DefaultValues,
      interrupts: collectInterrupts(snapshot),
      ...(declaredReply ? { reply: declaredReply.reply } : {}),
    });
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
    outcome = {
      status: finalStatus,
      values: snapshot.values as DefaultValues,
      interrupts: collectInterrupts(snapshot),
      ...(declaredReply ? { reply: declaredReply.reply } : {}),
    };
    return outcome;
  } catch (error) {
    const reason = control.reason.current;
    if (reason === "timeout") {
      const finalStatus = await settleRun("timeout", {
        values: {} as DefaultValues,
        error: RUN_TIMEOUT_ERROR,
      });
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
      const finalStatus = await settleRun(abortedStatus(reason), { values: {} as DefaultValues });
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
    const finalStatus = await settleRun("error", { values: {} as DefaultValues, error: wireError });
    if (finalStatus === "error") await mirrorThreadError(deps, threadId, wireError.message);
    // ALWAYS logged, ungated by `logRunActivity`: a run that fails silently is the whole problem
    // this reporting exists to solve. The report carries the original Error, so a console logger can
    // render its stack and `cause` chain.
    //
    // Assembling it is skipped entirely for the discarding default logger, because naming the node
    // that threw costs a checkpointer read — a network round trip in production. Paying that to
    // build an object nobody reads is waste on a path that has already gone wrong. Telemetry wants
    // the same node names, so the read happens once and both consumers share it.
    thrownError = toError(error);
    const reportingLogger = !isNoopLogger(deps.logger);
    // Gated on a sink that actually *consumes* run events, not merely on telemetry being on: a
    // trace-only sink (LangSmith contributes metadata and no `onRunEvent`) would otherwise pay a
    // checkpointer round trip per failure to build a field nothing reads.
    if (reportingLogger || deps.telemetryWantsRunEvents) {
      failingNodes = await readFailingNodes(graph, threadId);
    }
    if (reportingLogger) {
      deps.logger.error(`Graph run failed: ${wireError.message}`, {
        kind: RUN_FAILURE_REPORT_KIND,
        runId,
        threadId,
        assistantId: run.assistant_id,
        failingNodes: failingNodes ?? [],
        error: thrownError,
        wireError,
      } satisfies RunFailureReport);
    }
    logFinished(finalStatus);
    webhookErrorMessage = wireError.message;
    outcome = { status: finalStatus, values: {} as DefaultValues, error: wireError };
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Close the telemetry span the `try` opened, BEFORE anything here that can reject. `bus.close`
    // can (a Redis blip), and a rejection escaping this block would skip the event — leaving a
    // span-based sink holding an unclosed span for a run that is definitively over. Enough of those
    // and it hits its in-flight ceiling and silently stops recording.
    //
    // Fires for *every* terminal status — success, error, cancelled, timeout, interrupted — and is
    // ungated by `logRunActivity`: this is the record of what happened, not the verbose chatter that
    // flag controls. A sink is server-side like the log, so it gets the original `Error` whatever
    // `exposeErrorStacks` says.
    if (telemetryContext) {
      const endedAt = deps.clock();
      emitRunEvent(deps, {
        type: "run.finished",
        context: telemetryContext,
        status: outcome.status,
        durationMs: endedAt.getTime() - startedAt,
        frameCount: seq,
        endedAt,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(failingNodes !== undefined ? { failingNodes } : {}),
        ...(thrownError !== undefined ? { cause: thrownError } : {}),
      });
    }
    // Always close the bus so every subscriber's iterator completes and emits the terminal event.
    await deps.bus.close(runId);
    // Run-completion webhook: the first attempt, made inline so a healthy receiver still hears within
    // milliseconds rather than at the next worker tick. A failure is logged and recorded, never
    // propagated — it must not fail or delay the run.
    //
    // Two shapes, and which one runs depends on the driver rather than on configuration. With an
    // outbox, `settleRun` already committed the delivery alongside the run's status, so all that is
    // left is to attempt it; if this process dies first, its lease expires and a worker takes over.
    // Without one, this is the pre-outbox path verbatim: one POST, logged on failure, gone if it
    // fails.
    const deliver = deliverRecorded(deps, recordedDelivery) ?? deliverOnce(deps, exec, outcome);
    if (deliver) {
      // Handed to the caller rather than awaited here, when the caller asks for it. This `finally` runs
      // inside the thread's execution lock, so awaiting a hung target here blocks every other run on
      // the thread — and holds the payload, which carries the run's whole final state, alive for as
      // long as it hangs. See `startRunExecution`.
      if (exec.deferWebhook) exec.deferWebhook(deliver);
      else await deliver();
    }
  }

  /** The outbox path: attempt the delivery the finalize transaction already committed. */
  function deliverRecorded(
    resolved: ResolvedDeps,
    delivery: Delivery | undefined,
  ): (() => Promise<void>) | undefined {
    if (!delivery) return undefined;
    return async () => {
      await attemptDelivery(
        {
          store: resolved.store,
          webhookDispatcher: resolved.webhookDispatcher,
          logger: resolved.logger,
          clock: resolved.clock,
          ...(resolved.webhooks ? { webhooks: resolved.webhooks } : {}),
          // Present in a Redis deployment: the retry after this inline attempt is BullMQ's job,
          // not a poller's.
          ...(resolved.deliveryQueue ? { deliveryQueue: resolved.deliveryQueue } : {}),
        },
        delivery,
      );
    };
  }

  /**
   * The pre-outbox path, for a store with no `deliveries` repo — a third-party driver, or one
   * deliberately left on today's semantics. One POST, swallowed on failure, never retried.
   */
  function deliverOnce(
    resolved: ResolvedDeps,
    execution: RunExecution,
    settled: RunOutcome,
  ): (() => Promise<void>) | undefined {
    if (!started || execution.kwargs.webhook === undefined) return undefined;
    const url = execution.kwargs.webhook;
    const sentAt = resolved.clock().toISOString();
    const payload = {
      ...execution.run,
      status: settled.status,
      values: settled.values,
      run_started_at: new Date(startedAt).toISOString(),
      run_ended_at: sentAt,
      webhook_sent_at: sentAt,
      ...(webhookErrorMessage !== undefined ? { error: webhookErrorMessage } : {}),
      // Carried here too: a store with no `deliveries` repo is still a store whose receiver cannot
      // reach the question any other way. Omitting it would leave the gap open on exactly the drivers
      // least able to work around it.
      ...(settled.interrupts && Object.keys(settled.interrupts).length > 0
        ? { interrupts: settled.interrupts }
        : {}),
    };
    return async () => {
      try {
        await resolved.webhookDispatcher(url, payload);
      } catch (error) {
        resolved.logger.warn(
          `run ${runId}: webhook delivery to ${redactWebhookUrl(url)} failed`,
          error,
        );
      }
    };
  }
}
