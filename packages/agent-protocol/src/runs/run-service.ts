// The run-facing service: the three run modes plus get/list/cancel/join. Every mode funnels through
// the one engine (`executeRun`) so behavior can't drift between them — wait awaits the outcome,
// stream subscribes to the bus while the engine runs inline, background enqueues for a worker.

import {
  isTerminalRunStatus,
  SkeinHttpError,
  type Config,
  type DefaultValues,
  type Metadata,
  type MultitaskStrategy,
  type Run,
  type RunFrame,
  type RunKwargs,
  type RunStatus,
  type StreamMode,
} from "@skein-js/core";

import type { ProtocolContext } from "../context.js";

import { executeRun } from "./run-engine.js";

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

/** Keep only the defined fields, so a run's stored kwargs stay minimal. */
function toKwargs(input: CreateRunInput): RunKwargs {
  const kwargs: RunKwargs = {};
  if (input.input !== undefined) kwargs.input = input.input;
  if (input.command !== undefined) kwargs.command = input.command;
  if (input.config !== undefined) kwargs.config = input.config;
  if (input.context !== undefined) kwargs.context = input.context;
  if (input.stream_mode !== undefined) kwargs.stream_mode = input.stream_mode;
  if (input.interrupt_before !== undefined) kwargs.interrupt_before = input.interrupt_before;
  if (input.interrupt_after !== undefined) kwargs.interrupt_after = input.interrupt_after;
  return kwargs;
}

export function createRunService(ctx: ProtocolContext): RunService {
  const { deps, control, locks } = ctx;

  const requireThread = async (threadId: string): Promise<void> => {
    if (!(await deps.store.threads.get(threadId))) {
      throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
    }
  };

  const requireAssistant = async (assistantId: string): Promise<string> => {
    const assistant = await deps.store.assistants.get(assistantId);
    if (!assistant) throw SkeinHttpError.notFound(`Assistant "${assistantId}" not found.`);
    return assistant.assistant_id;
  };

  // A stateless run creates (or reuses) its thread; a thread-scoped run's thread must already exist.
  const ensureThread = async (threadId?: string): Promise<string> => {
    if (threadId === undefined) return (await deps.store.threads.create()).thread_id;
    const existing = await deps.store.threads.get(threadId);
    return (existing ?? (await deps.store.threads.create({ thread_id: threadId }))).thread_id;
  };

  // Create the pending run row under the per-thread lock, enforcing the concurrency guard atomically.
  // The assistant is resolved by the caller *before* any thread is created, so an invalid
  // assistant_id never leaves an orphaned thread behind.
  const createPendingRun = async (
    input: CreateRunInput,
    threadId: string,
    assistantId: string,
    kwargs: RunKwargs,
  ): Promise<Run> => {
    return locks.run(threadId, async () => {
      const strategy = input.multitask_strategy ?? "reject";
      if (await deps.store.runs.hasActiveRun(threadId)) {
        if (strategy !== "reject") {
          deps.logger.warn(`multitask_strategy "${strategy}" treated as reject (MVP).`);
        }
        throw SkeinHttpError.conflict(`Thread "${threadId}" already has an active run.`, {
          code: "thread_busy",
        });
      }
      return deps.store.runs.create({
        thread_id: threadId,
        assistant_id: assistantId,
        status: "pending",
        metadata: input.metadata,
        multitask_strategy: strategy,
        kwargs,
      });
    });
  };

  // Execute a run inline (wait/stream), publishing frames to the bus. Returns the outcome promise.
  const runInline = (run: Run, kwargs: RunKwargs) => {
    const runControl = control.register(run.run_id);
    const done = executeRun(deps, { run, kwargs, control: runControl }).finally(() =>
      control.clear(run.run_id),
    );
    return done;
  };

  return {
    async createWait(input) {
      const assistantId = await requireAssistant(input.assistant_id);
      const threadId = await ensureThread(input.thread_id);
      const kwargs = toKwargs(input);
      const run = await createPendingRun(input, threadId, assistantId, kwargs);
      const outcome = await runInline(run, kwargs);
      return outcome.values;
    },

    async createStream(input) {
      const assistantId = await requireAssistant(input.assistant_id);
      const threadId = await ensureThread(input.thread_id);
      const kwargs = toKwargs(input);
      const run = await createPendingRun(input, threadId, assistantId, kwargs);
      // Kick off execution; the subscription below replays from seq 0 (frames are buffered), so
      // nothing is lost between starting the run and subscribing.
      void runInline(run, kwargs).catch((error: unknown) =>
        deps.logger.error("stream run failed", error),
      );
      return { runId: run.run_id, frames: deps.bus.subscribe(run.run_id, 0) };
    },

    async createBackground(threadId, input) {
      const assistantId = await requireAssistant(input.assistant_id);
      await requireThread(threadId);
      const kwargs = toKwargs(input);
      const run = await createPendingRun(
        { ...input, thread_id: threadId },
        threadId,
        assistantId,
        kwargs,
      );
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
      // Idempotent: cancelling a finished run is a no-op.
      if (isTerminalRunStatus(run.status)) return run;

      if (run.status === "pending") {
        // Queued but not started: finalize it and free the thread; the worker skips it on dequeue.
        await deps.store.runs.setStatus(runId, "error");
        await deps.store.threads.update(run.thread_id, { status: "idle" });
        await deps.bus.close(runId);
        control.abort(runId, "cancel"); // no-op if not yet executing
      } else {
        // Running: mark terminal now (the engine won't overwrite it) and abort to stop the graph;
        // the engine's finally closes the bus and mirrors the thread back to idle.
        await deps.store.runs.setStatus(runId, "error");
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
