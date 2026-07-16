// The run-facing service: the three run modes plus get/list/cancel/join. Every mode funnels through
// the one engine (`executeRun`) so behavior can't drift between them — wait awaits the outcome,
// stream subscribes to the bus while the engine runs inline, background enqueues for a worker.

import {
  isTerminalRunStatus,
  SkeinHttpError,
  type Assistant,
  type AuthUser,
  type Config,
  type DefaultValues,
  type Metadata,
  type MultitaskStrategy,
  type Run,
  type RunFrame,
  type RunKwargs,
  type RunStatus,
  type StreamMode,
  type Thread,
} from "@skein-js/core";

import type { ProtocolContext, RollbackPlan } from "../context.js";

import { startRunExecution } from "./run-execution.js";

/** A run request as it arrives from any of the run endpoints (already validated). */
export interface CreateRunInput {
  thread_id?: string;
  assistant_id: string;
  input?: unknown;
  command?: { resume?: unknown; update?: unknown; goto?: unknown };
  config?: Config;
  context?: unknown;
  stream_mode?: StreamMode | StreamMode[];
  metadata?: Metadata;
  multitask_strategy?: MultitaskStrategy;
  interrupt_before?: string[] | "*";
  interrupt_after?: string[] | "*";
  /** Absolute `http(s)` URL POSTed with the settled run once it reaches a terminal status. */
  webhook?: string;
}

/** A started streaming run: its id, plus the live frame iterable to serialize as SSE. */
export interface StartedStream {
  runId: string;
  frames: AsyncIterable<RunFrame>;
}

export interface RunService {
  createWait(input: CreateRunInput): Promise<DefaultValues>;
  createStream(input: CreateRunInput): Promise<StartedStream>;
  createBackground(threadId: string, input: CreateRunInput): Promise<Run>;
  get(runId: string): Promise<Run>;
  listByThread(threadId: string): Promise<Run[]>;
  cancel(runId: string): Promise<Run>;
  delete(runId: string): Promise<void>;
  join(runId: string, afterSeq?: number): Promise<AsyncIterable<RunFrame>>;
  /** The terminal status of a run for the SSE terminal event, or null if the run is gone. */
  finalStatus(runId: string): Promise<RunStatus | null>;
}

/**
 * Keep only the defined fields, so a run's stored kwargs stay minimal. The authenticated caller (and
 * its scopes) is stamped by the server (from the request context, never the client body) so the run
 * engine can inject it into the graph's `configurable.langgraph_auth_user`.
 */
function toKwargs(input: CreateRunInput, authUser?: AuthUser, authScopes?: string[]): RunKwargs {
  const kwargs: RunKwargs = {};
  if (input.input !== undefined) kwargs.input = input.input;
  if (input.command !== undefined) kwargs.command = input.command;
  if (input.config !== undefined) kwargs.config = input.config;
  if (input.context !== undefined) kwargs.context = input.context;
  if (input.stream_mode !== undefined) kwargs.stream_mode = input.stream_mode;
  if (input.interrupt_before !== undefined) kwargs.interrupt_before = input.interrupt_before;
  if (input.interrupt_after !== undefined) kwargs.interrupt_after = input.interrupt_after;
  if (input.webhook !== undefined) kwargs.webhook = input.webhook;
  // Scopes only ride along with a principal; storing them alone would be meaningless.
  if (authUser !== undefined) {
    kwargs.auth_user = authUser;
    if (authScopes !== undefined) kwargs.auth_scopes = authScopes;
  }
  return kwargs;
}

export function createRunService(ctx: ProtocolContext): RunService {
  const { deps, control, locks, runBaseCheckpoints, authUser, authScopes } = ctx;

  const requireThread = async (threadId: string): Promise<Thread> => {
    const thread = await deps.store.threads.get(threadId);
    if (!thread) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
    return thread;
  };

  const requireAssistant = async (assistantId: string): Promise<Assistant> => {
    const assistant = await deps.store.assistants.get(assistantId);
    if (!assistant) throw SkeinHttpError.notFound(`Assistant "${assistantId}" not found.`);
    return assistant;
  };

  // Stamp the run's graph + assistant onto the thread's metadata so `POST /threads/search` can
  // filter threads by graph via `{ metadata: { graph_id } }` — the LangGraph-compatible path, using
  // the metadata subset match the store search already does (no dedicated query field needed). The
  // thread reflects its *most recent* run's graph; merge because `ThreadUpdate.metadata` replaces.
  // Takes the thread the caller already loaded (no re-fetch) and is best-effort: this metadata is
  // only for search filtering, so a stamp failure must never fail run creation or strand the run.
  const stampGraphOnThread = async (thread: Thread, assistant: Assistant): Promise<void> => {
    if (
      thread.metadata?.["graph_id"] === assistant.graph_id &&
      thread.metadata?.["assistant_id"] === assistant.assistant_id
    ) {
      return; // already tagged with this graph/assistant — skip the redundant write
    }
    try {
      await deps.store.threads.update(thread.thread_id, {
        metadata: {
          ...thread.metadata,
          graph_id: assistant.graph_id,
          assistant_id: assistant.assistant_id,
        },
      });
    } catch (error) {
      deps.logger.warn("failed to stamp graph_id/assistant_id onto thread", error);
    }
  };

  // A stateless run creates (or reuses) its thread; a thread-scoped run's thread must already exist.
  const ensureThread = async (threadId?: string): Promise<Thread> => {
    if (threadId === undefined) return deps.store.threads.create();
    const existing = await deps.store.threads.get(threadId);
    return existing ?? (await deps.store.threads.create({ thread_id: threadId }));
  };

  // Stop an active run being displaced by an `interrupt`/`rollback` run. A pending (never-started)
  // run is finalized directly and its bus closed; a running run is signaled and finalized by its
  // engine (interrupt -> `interrupted`, keeping its writes; rollback -> `cancelled`, its writes
  // dropped afterward by the displacing run). Marking the row terminal here frees the concurrency
  // guard immediately, while the execution lock still holds the displacing run until this one stops.
  const cancelActiveRun = async (run: Run, reason: "interrupt" | "rollback"): Promise<void> => {
    const terminal: RunStatus = reason === "interrupt" ? "interrupted" : "cancelled";
    if (run.status === "pending") {
      await deps.store.runs.setStatus(run.run_id, terminal);
      await deps.bus.close(run.run_id);
      control.abort(run.run_id, reason); // no-op if not executing
    } else {
      await deps.store.runs.setStatus(run.run_id, terminal);
      control.abort(run.run_id, reason);
    }
  };

  // Create the pending run row under the per-thread lock, applying the requested multitask strategy
  // atomically against the thread's inflight runs. The assistant is resolved by the caller *before*
  // any thread is created, so an invalid assistant_id never leaves an orphaned thread behind.
  const createPendingRun = async (
    input: CreateRunInput,
    threadId: string,
    assistantId: string,
    kwargs: RunKwargs,
  ): Promise<Run> => {
    return locks.run(threadId, async () => {
      const strategy = input.multitask_strategy ?? "reject";
      const active = await deps.store.runs.listActiveRuns(threadId);

      let rollbackPlan: RollbackPlan | undefined;
      if (active.length > 0) {
        if (strategy === "reject") {
          // Matches @langchain/langgraph-api: 422, with the same message.
          throw SkeinHttpError.unprocessable(
            "Thread is already running a task. Wait for it to finish or choose a different multitask strategy.",
            { code: "thread_busy" },
          );
        }
        if (strategy === "interrupt") {
          for (const run of active) await cancelActiveRun(run, "interrupt");
        } else if (strategy === "rollback") {
          // Capture the running run's base checkpoint *before* aborting — the engine clears it once
          // the run settles. A displaced run with no recorded base never wrote checkpoints.
          let revertToCheckpoint: RollbackPlan["revertToCheckpoint"] = false;
          for (const run of active) {
            if (runBaseCheckpoints.has(run.run_id)) {
              revertToCheckpoint = { baseCheckpointId: runBaseCheckpoints.get(run.run_id) };
            }
          }
          rollbackPlan = { revertToCheckpoint, displacedRunIds: active.map((run) => run.run_id) };
          for (const run of active) await cancelActiveRun(run, "rollback");
        }
        // enqueue: fall through and create the pending run; the per-thread execution lock
        // (startRunExecution) makes it wait behind the active run.
      }

      const created = await deps.store.runs.create({
        thread_id: threadId,
        assistant_id: assistantId,
        status: "pending",
        metadata: input.metadata,
        multitask_strategy: strategy,
        kwargs,
      });
      // Register the rollback work the new run must do before it executes (see startRunExecution).
      if (rollbackPlan) ctx.rollbackPlans.set(created.run_id, rollbackPlan);
      return created;
    });
  };

  // Execute a run inline (wait/stream) via the shared per-thread execution path, publishing frames
  // to the bus. Returns the outcome promise.
  const runInline = (run: Run, kwargs: RunKwargs) => startRunExecution(ctx, run, kwargs);

  return {
    async createWait(input) {
      const assistant = await requireAssistant(input.assistant_id);
      const thread = await ensureThread(input.thread_id);
      const kwargs = toKwargs(input, authUser, authScopes);
      const run = await createPendingRun(input, thread.thread_id, assistant.assistant_id, kwargs);
      await stampGraphOnThread(thread, assistant);
      const outcome = await runInline(run, kwargs);
      return outcome.values;
    },

    async createStream(input) {
      const assistant = await requireAssistant(input.assistant_id);
      const thread = await ensureThread(input.thread_id);
      const kwargs = toKwargs(input, authUser, authScopes);
      const run = await createPendingRun(input, thread.thread_id, assistant.assistant_id, kwargs);
      await stampGraphOnThread(thread, assistant);
      // Kick off execution; the subscription below replays from seq 0 (frames are buffered), so
      // nothing is lost between starting the run and subscribing.
      void runInline(run, kwargs).catch((error: unknown) =>
        deps.logger.error("stream run failed", error),
      );
      return { runId: run.run_id, frames: deps.bus.subscribe(run.run_id, 0) };
    },

    async createBackground(threadId, input) {
      const assistant = await requireAssistant(input.assistant_id);
      const thread = await requireThread(threadId);
      const kwargs = toKwargs(input, authUser, authScopes);
      const run = await createPendingRun(
        { ...input, thread_id: threadId },
        threadId,
        assistant.assistant_id,
        kwargs,
      );
      await stampGraphOnThread(thread, assistant);
      await deps.queue.enqueue({ run_id: run.run_id, thread_id: threadId });
      return run;
    },

    async get(runId) {
      const run = await deps.store.runs.get(runId);
      if (!run) throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
      return run;
    },

    async listByThread(threadId) {
      await requireThread(threadId);
      return deps.store.runs.listByThread(threadId);
    },

    async cancel(runId) {
      const run = await deps.store.runs.get(runId);
      if (!run) throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
      // Drop any rollback work this run was going to do on execution: cancelling it means it won't
      // run, so the plan would otherwise be orphaned in the map (it's applied in startRunExecution).
      ctx.rollbackPlans.delete(runId);
      // Idempotent: cancelling a finished run is a no-op.
      if (isTerminalRunStatus(run.status)) return run;

      if (run.status === "pending") {
        // Queued but not started: finalize it and free the thread; the worker skips it on dequeue.
        await deps.store.runs.setStatus(runId, "cancelled");
        await deps.store.threads.update(run.thread_id, { status: "idle" });
        await deps.bus.close(runId);
        control.abort(runId, "cancel"); // no-op if not yet executing
      } else {
        // Running: mark terminal now (the engine won't overwrite it) and abort to stop the graph;
        // the engine's finally closes the bus and mirrors the thread back to idle.
        await deps.store.runs.setStatus(runId, "cancelled");
        await deps.store.threads.update(run.thread_id, { status: "idle" });
        control.abort(runId, "cancel");
      }
      return (await deps.store.runs.get(runId)) ?? run;
    },

    async delete(runId) {
      if (!(await deps.store.runs.get(runId))) {
        throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
      }
      // Stop it first if it's still executing, so nothing writes to a deleted run.
      control.abort(runId, "cancel");
      ctx.rollbackPlans.delete(runId); // a deleted run won't execute, so its plan must not linger
      await deps.store.runs.delete(runId);
    },

    async join(runId, afterSeq = 0) {
      if (!(await deps.store.runs.get(runId))) {
        throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
      }
      return deps.bus.subscribe(runId, afterSeq);
    },

    async finalStatus(runId) {
      const run = await deps.store.runs.get(runId);
      return run?.status ?? null;
    },
  };
}
