// The run-facing service: the three run modes plus get/list/cancel/join. Every mode funnels through
// the one engine (`executeRun`) so behavior can't drift between them — wait awaits the outcome,
// stream subscribes to the bus while the engine runs inline, background enqueues for a worker.

import {
  isSkeinHttpError,
  isTerminalRunStatus,
  SkeinHttpError,
  type Assistant,
  type AuthUser,
  type Config,
  type DefaultValues,
  type Metadata,
  type MultitaskStrategy,
  type Run,
  type RunError,
  type RunFrame,
  type RunKwargs,
  type RunListQuery,
  type RunStatus,
  type RunTrigger,
  type StreamMode,
  type Thread,
} from "@skein-js/core";

import { toStoredRollbackPlan, type ProtocolContext, type RollbackPlan } from "../context.js";
import { rollbackThreadCheckpointsTo } from "../threads/checkpoint-history.js";

import { startRunExecution } from "./run-execution.js";
import { withThreadExecution } from "./thread-locks.js";

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
  /**
   * What to do with a **stateless** run's auto-created thread once the run settles. Ignored for a
   * thread-scoped run: that thread belongs to the caller, not to the run.
   *
   * Defaults to `"keep"`. LangGraph defaults to `"delete"`; skein keeps the thread so a stateless run
   * stays inspectable afterwards and so this field's arrival did not silently change what
   * `/runs/wait` and `/runs/stream` already did. Pass `"delete"` for LangGraph's behaviour.
   */
  on_completion?: "delete" | "keep";
  /** Time travel: fork this run from a prior checkpoint instead of the thread tip (server-validated). */
  checkpoint_id?: string;
  /**
   * What to do when the named thread does not exist: `"reject"` (the default, and LangGraph's) 404s,
   * `"create"` brings it into existence first. Ignored when no thread was named — the server owns a
   * stateless run's thread either way.
   */
  if_not_exists?: "create" | "reject";
  /**
   * Seconds to wait before the run starts. A background run is held by the queue; an inline
   * (`wait`/`stream`) run is held by the server with the caller's connection still open.
   *
   * The run row exists for the whole delay with status `pending`, so it counts as inflight — a second
   * run on the same thread under the default `multitask_strategy: "reject"` is refused until it
   * starts. That is the honest reading: work *is* scheduled on the thread.
   */
  after_seconds?: number;
}

/**
 * A started streaming run: its ids, plus the live frame iterable to serialize as SSE.
 *
 * `threadId` is here so the transport can answer with `Content-Location:
 * /threads/{thread_id}/runs/{run_id}` — the header the SDK parses to fire `onRunCreated`, which is
 * what `useStream` stores to rejoin a run after a remount. A stateless run's thread is created by the
 * server, so the caller has no other way to learn it.
 */
export interface StartedStream {
  runId: string;
  threadId: string;
  frames: AsyncIterable<RunFrame>;
  /**
   * The run's terminal status, for the SSE stream's synthesized `end` event.
   *
   * Resolved from the **execution outcome** rather than by re-reading the run row, which is racy for a
   * run whose row is about to disappear: `on_completion: "delete"` removes the thread once the run
   * settles, and that cascades the run away. A lost race there makes `finalStatus` answer `null`, which
   * the SSE builder reads as `"success"` — so a cancelled or timed-out stateless run would close its
   * stream claiming it succeeded.
   *
   * Absent for a *joined* stream (`GET .../stream`), which has no outcome promise to read and whose run
   * is not being deleted; the transport falls back to `RunService.finalStatus` there.
   */
  finalStatus?: () => Promise<RunStatus | null>;
}

/**
 * A finished `POST /runs/wait` run: what to send back, plus the ids for its `Content-Location`.
 *
 * The ids travel alongside the body rather than in it — the body is the graph's state, and the SDK
 * hands it to the caller verbatim, so there is nowhere in it to put them.
 */
export interface CompletedWaitRun {
  runId: string;
  threadId: string;
  result: WaitRunResult;
}

/**
 * What a cancel should do beyond settling the run — the `?action` and `?wait` the SDK sends on every
 * `client.runs.cancel(...)` call and skein used to ignore.
 */
export interface CancelRunOptions {
  /**
   * `"interrupt"` (the default, and LangGraph's) settles the run `cancelled` and **keeps** whatever it
   * already wrote to the thread. `"rollback"` additionally discards those checkpoint writes and
   * deletes the run row, so the turn reads as never having happened — the same treatment
   * `multitask_strategy: "rollback"` gives a displaced run.
   */
  action?: "interrupt" | "rollback";
  /**
   * Return only once the run has actually stopped executing, rather than as soon as it has been
   * marked cancelled and signalled.
   *
   * Waits on the thread's execution claim, so with a `threadExecutionGate` configured it is exact for a
   * run executing on any instance; without one it covers this process (which is the whole deployment).
   */
  wait?: boolean;
}

/** Which runs `POST /runs/cancel` should target. Narrowest wins: `runIds`, then `threadId`, then all. */
export interface CancelManyQuery extends CancelRunOptions {
  threadId?: string;
  runIds?: string[];
  /** `"all"` (the default) means every inflight run; the others narrow to that single status. */
  status?: "pending" | "running" | "all";
}

export interface CancelManyResult {
  /** The runs actually cancelled — an unknown or non-owned id is skipped rather than failing the sweep. */
  cancelledRunIds: string[];
  /**
   * True when the whole-server sweep filled the store's page bound, so inflight runs may remain and the
   * caller should sweep again. Reporting a bounded sweep as a complete one is how "cancel everything"
   * silently leaves runs going.
   *
   * Derived from the sweep's own read rather than from a second, wider one — deliberately. A re-read of
   * every inflight run cannot be ownership-scoped (the guard it goes through must see other principals'
   * runs, by design), so its *count* would tell an authenticated caller how much work every other tenant
   * has in flight. A boolean about the caller's own page leaks nothing. Always `false` for the
   * thread-scoped and explicit-id forms, which have no bound to hit.
   */
  truncated: boolean;
}

/**
 * The body of `POST /runs/wait`: the graph's final state values, or — when the run failed — the
 * reason under `__error__`. Both are objects, so the union is structural rather than discriminated;
 * it exists to make the failure case visible in the signature instead of hidden behind a cast.
 */
export type WaitRunResult = DefaultValues | { __error__: RunError };

export interface RunService {
  createWait(input: CreateRunInput): Promise<CompletedWaitRun>;
  createStream(input: CreateRunInput): Promise<StartedStream>;
  createBackground(threadId: string, input: CreateRunInput): Promise<Run>;
  /**
   * Start a background run on a **server-created** thread — `POST /runs`. The stateless sibling of
   * {@link createBackground}, which requires the thread to already exist.
   */
  createStatelessBackground(input: CreateRunInput): Promise<Run>;
  /**
   * Start a batch of stateless background runs — `POST /runs/batch`. Each gets its own thread. Created
   * in order and one at a time, so a failure part-way leaves a prefix created rather than an
   * unpredictable subset.
   */
  createBatch(inputs: CreateRunInput[]): Promise<Run[]>;
  get(runId: string): Promise<Run>;
  listByThread(threadId: string, query?: RunListQuery): Promise<Run[]>;
  cancel(runId: string, options?: CancelRunOptions): Promise<Run>;
  /**
   * Cancel many runs at once — `POST /runs/cancel`. Targets are the named `runIds`, else the inflight
   * runs of `threadId`, else every inflight run on the server. Returns what it actually cancelled.
   */
  cancelMany(query: CancelManyQuery): Promise<CancelManyResult>;
  delete(runId: string): Promise<void>;
  join(runId: string, afterSeq?: number): Promise<AsyncIterable<RunFrame>>;
  /** The terminal status of a run for the SSE terminal event, or null if the run is gone. */
  finalStatus(runId: string): Promise<RunStatus | null>;
}

/**
 * Keep only the defined fields, so a run's stored kwargs stay minimal. The authenticated caller (and
 * its scopes) is stamped by the server (from the request context, never the client body) so the run
 * engine can inject it into the graph's `configurable.langgraph_auth_user`.
 *
 * `ownsThread` says whether the server created this run's thread for it, which is the only case where
 * `on_completion` applies — see `RunKwargs.delete_thread_on_completion`.
 */
/**
 * Exported so the cron scheduler builds a fired run's payload through the *same* function an HTTP
 * run-create goes through. A cron replays a stored run body with no request behind it, so a second
 * spelling of this mapping would drift silently — a run field honoured over HTTP and dropped on a
 * schedule, with nothing failing to say so.
 */
export function toKwargs(
  input: CreateRunInput,
  ownsThread: boolean,
  authUser?: AuthUser,
  authScopes?: string[],
): RunKwargs {
  const kwargs: RunKwargs = {};
  // Only the non-default is stored: `keep` is what an absent flag already means, and kwargs are
  // written on every run.
  if (ownsThread && input.on_completion === "delete") kwargs.delete_thread_on_completion = true;
  if (input.input !== undefined) kwargs.input = input.input;
  if (input.command !== undefined) kwargs.command = input.command;
  if (input.config !== undefined) kwargs.config = input.config;
  if (input.context !== undefined) kwargs.context = input.context;
  if (input.stream_mode !== undefined) kwargs.stream_mode = input.stream_mode;
  if (input.interrupt_before !== undefined) kwargs.interrupt_before = input.interrupt_before;
  if (input.interrupt_after !== undefined) kwargs.interrupt_after = input.interrupt_after;
  if (input.webhook !== undefined) kwargs.webhook = input.webhook;
  // Server-owned fork target: taken from the validated top-level field, never from client config.
  if (input.checkpoint_id !== undefined) kwargs.checkpoint_id = input.checkpoint_id;
  // Scopes only ride along with a principal; storing them alone would be meaningless.
  if (authUser !== undefined) {
    kwargs.auth_user = authUser;
    if (authScopes !== undefined) kwargs.auth_scopes = authScopes;
  }
  return kwargs;
}

export function createRunService(ctx: ProtocolContext): RunService {
  const { deps, control, locks, runBaseCheckpoints, authUser, authScopes } = ctx;

  /**
   * The checkpoint tip a run started from — the in-process note first, then the run's persisted kwargs.
   *
   * `recorded` is what matters and why this is not just `string | undefined`: a run that never recorded
   * a base must have its checkpoints left alone, while one that recorded *no* checkpoint should be
   * reverted to empty. Collapsing the two would make a rollback wipe history the run never wrote.
   */
  const readBaseCheckpoint = async (
    runId: string,
  ): Promise<{ recorded: boolean; checkpointId: string | undefined }> => {
    if (runBaseCheckpoints.has(runId)) {
      return { recorded: true, checkpointId: runBaseCheckpoints.get(runId) };
    }
    const kwargs = await deps.store.runs.getKwargs(runId);
    if (kwargs === null || !("base_checkpoint_id" in kwargs)) {
      return { recorded: false, checkpointId: undefined };
    }
    return { recorded: true, checkpointId: kwargs.base_checkpoint_id ?? undefined };
  };

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

  // Get-or-create by id. The read comes first for the common case, but the create can still lose a
  // race with a concurrent caller — the driver enforces uniqueness now, so that shows up as a 409
  // rather than as a silent overwrite. Recover by re-reading: whoever won created the thread this
  // caller wanted, so the outcome is the same.
  const ensureThread = async (threadId: string): Promise<Thread> => {
    const existing = await deps.store.threads.get(threadId);
    if (existing) return existing;
    try {
      return await deps.store.threads.create({ thread_id: threadId });
    } catch (error) {
      if (isSkeinHttpError(error) && error.status === 409) {
        const raced = await deps.store.threads.get(threadId);
        if (raced) return raced;
      }
      throw error;
    }
  };

  /**
   * Resolve the thread a run executes on — the one thing that differs between the run modes, and
   * therefore the thing `prepareRun` takes as a parameter.
   *
   * A caller who named no thread gets a server-created one (that is what "stateless" means). A caller
   * who named one gets LangGraph's `if_not_exists`: `reject` by default, so an unknown id is a 404
   * rather than a silently-created empty thread that the run then executes against with none of the
   * history the caller expected.
   *
   * That default is what makes the three thread-scoped create routes agree. They used to disagree:
   * `/threads/{id}/runs/wait` and `.../stream` fold the path id into the body and went through a
   * get-or-create, so they created; `/threads/{id}/runs` required the thread and 404d.
   */
  const resolveRunThread = (
    threadId: string | undefined,
    ifNotExists: "create" | "reject" = "reject",
  ): Promise<Thread> => {
    if (threadId === undefined) return deps.store.threads.create();
    return ifNotExists === "create" ? ensureThread(threadId) : requireThread(threadId);
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

      // `reject` is decided by the *driver*, in one atomic check-and-insert, so two instances racing the
      // same thread cannot both win. The in-process lock around it is still worth holding — it keeps a
      // single process from spending a round trip per concurrent request to lose the same race — but it
      // is no longer what makes this correct.
      if (strategy === "reject") {
        const created = await deps.store.runs.createIfThreadIdle({
          thread_id: threadId,
          assistant_id: assistantId,
          status: "pending",
          metadata: input.metadata,
          multitask_strategy: strategy,
          kwargs,
        });
        if (!created) {
          // Matches @langchain/langgraph-api: 422, with the same message.
          throw SkeinHttpError.unprocessable(
            "Thread is already running a task. Wait for it to finish or choose a different multitask strategy.",
            { code: "thread_busy" },
          );
        }
        return created;
      }

      const active = await deps.store.runs.listActiveRuns(threadId);

      let rollbackPlan: RollbackPlan | undefined;
      if (active.length > 0) {
        if (strategy === "interrupt") {
          for (const run of active) await cancelActiveRun(run, "interrupt");
        } else if (strategy === "rollback") {
          // Capture the running run's base checkpoint *before* aborting — the engine clears its
          // in-process note once the run settles. A displaced run with no recorded base never wrote
          // checkpoints.
          let revertToCheckpoint: RollbackPlan["revertToCheckpoint"] = false;
          for (const run of active) {
            const base = await readBaseCheckpoint(run.run_id);
            if (base.recorded) revertToCheckpoint = { baseCheckpointId: base.checkpointId };
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
        // The plan rides the run's own kwargs, so whichever instance ends up executing this run applies
        // it — and so a run recovered after a crash still cleans up what it displaced. Written with the
        // rest of the kwargs, costing no extra round trip.
        kwargs: rollbackPlan
          ? { ...kwargs, rollback_plan: toStoredRollbackPlan(rollbackPlan) }
          : kwargs,
      });
      // Also noted in-process, as the fast path for the common single-instance case: the executing run
      // then needs no read to discover it has work to do first.
      if (rollbackPlan) ctx.rollbackPlans.set(created.run_id, rollbackPlan);
      return created;
    });
  };

  // Execute a run inline (wait/stream) via the shared per-thread execution path, publishing frames
  // to the bus. Returns the outcome promise. `trigger` is telemetry-only — it distinguishes the two
  // inline shapes, which have very different latency profiles worth separating in a dashboard.
  const runInline = (run: Run, kwargs: RunKwargs, trigger: RunTrigger) =>
    startRunExecution(ctx, run, kwargs, { trigger });

  /**
   * The prologue every run mode shares: resolve the assistant *before* any thread is created (so a bad
   * `assistant_id` never orphans one), resolve the thread, build the kwargs, create the pending row
   * under the multitask guard, and stamp the graph onto the thread.
   *
   * Thread resolution is the only real difference between the modes, so it is the parameter:
   * thread-scoped runs require the thread to exist, stateless ones have the server make it.
   */
  const prepareRun = async (
    input: CreateRunInput,
    resolveThread: () => Promise<Thread>,
  ): Promise<{ run: Run; kwargs: RunKwargs }> => {
    const assistant = await requireAssistant(input.assistant_id);
    const thread = await resolveThread();
    // "Stateless" is *the caller named no thread*, matching LangGraph's own `threadId == null` test —
    // not "we happened to create one". A caller that supplies an id owns that thread even when this
    // run is what brings it into existence, so `on_completion: "delete"` must not reach for it.
    const kwargs = toKwargs(input, input.thread_id === undefined, authUser, authScopes);
    const run = await createPendingRun(
      { ...input, thread_id: thread.thread_id },
      thread.thread_id,
      assistant.assistant_id,
      kwargs,
    );
    await stampGraphOnThread(thread, assistant);
    return { run, kwargs };
  };

  /**
   * Queue a prepared background run for the worker. Shared by the thread-scoped and stateless forms.
   *
   * `after_seconds` becomes the queue's own delay rather than a timer here: the driver is what
   * actually holds the run (BullMQ's delayed set on Redis, so it survives a restart), and a delay
   * kept in this process would be lost the moment the request that created it returned.
   */
  const enqueueBackgroundRun = async (run: Run, afterSeconds?: number): Promise<Run> => {
    await deps.queue.enqueue(
      { run_id: run.run_id, thread_id: run.thread_id },
      afterSeconds !== undefined && afterSeconds > 0 ? { delayMs: afterSeconds * 1000 } : undefined,
    );
    return run;
  };

  /**
   * Hold an **inline** run for its `after_seconds` before executing it.
   *
   * There is no queue on the `wait`/`stream` path — the caller is holding the connection — so the wait
   * happens here. The run row and its ids are created *first*, so a stream's `Content-Location` header
   * goes out immediately and the SSE heartbeat keeps the connection alive across the gap; only
   * execution is deferred.
   */
  const holdInlineRun = async (afterSeconds?: number): Promise<void> => {
    if (afterSeconds === undefined || afterSeconds <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, afterSeconds * 1000);
      timer.unref?.();
    });
  };

  /**
   * Discard a cancelled run's checkpoint writes — `?action=rollback`.
   *
   * Runs **holding the thread's execution claim**, which is what makes it safe: the claim is held by
   * the run being cancelled until its engine finishes unwinding, so acquiring it here queues behind that
   * and the revert cannot race the writes it is undoing. Taken through `withThreadExecution`, so with a
   * `threadExecutionGate` configured it waits for the run even when that run is executing on **another
   * instance** — the local lock alone is uncontended there, and the revert would delete and replay the
   * thread's checkpoints while the peer's graph was still writing supersteps.
   *
   * The base checkpoint is read by the caller *before* the abort, because the engine clears its
   * in-process note as the run settles.
   *
   * Best-effort, and deliberately so: the run is cancelled either way, and failing the cancel because
   * the cleanup failed would leave the caller thinking the run is still going. A failure is logged at
   * `error`, not `warn` — the thread is left carrying writes the caller asked to have removed.
   */
  const rollbackCancelledRun = async (
    run: Run,
    baseCheckpointId: string | undefined,
  ): Promise<void> => {
    try {
      await withThreadExecution(ctx.executionLocks, deps.threadExecutionGate, run.thread_id, () =>
        rollbackThreadCheckpointsTo(deps.checkpointer, run.thread_id, baseCheckpointId),
      );
      // The row goes last, so a failed revert above leaves the run visible and its writes explained
      // rather than a deleted run and an unexplained thread.
      await deps.store.runs.delete(run.run_id);
    } catch (error) {
      deps.logger.error(
        `run ${run.run_id}: cancel requested action=rollback, but discarding its writes failed — ` +
          `the run is cancelled and the thread still carries them.`,
        error,
      );
    }
  };

  const cancelRun = async (runId: string, options?: CancelRunOptions): Promise<Run> => {
    const run = await deps.store.runs.get(runId);
    if (!run) throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
    // Drop any rollback work this run was going to do on execution: cancelling it means it won't
    // run, so the plan would otherwise be orphaned in the map (it's applied in startRunExecution).
    ctx.rollbackPlans.delete(runId);
    // Idempotent: cancelling a finished run is a no-op.
    if (isTerminalRunStatus(run.status)) return run;

    // Read before the abort: the engine clears its in-process note as the run settles, so reading it
    // afterwards could find nothing and the revert would wipe the thread instead of trimming it.
    const rollingBack = options?.action === "rollback";
    const base = rollingBack
      ? await readBaseCheckpoint(runId)
      : { recorded: false, checkpointId: undefined };

    // Both branches mark the row terminal (the engine won't overwrite it) and free the thread; a
    // pending run additionally has its bus closed here, since no engine will do it. `abort` is a no-op
    // when the run is not executing in this process.
    await deps.store.runs.setStatus(runId, "cancelled");
    await deps.store.threads.update(run.thread_id, { status: "idle" });
    if (run.status === "pending") await deps.bus.close(runId);
    control.abort(runId, rollingBack ? "rollback" : "cancel");

    // A run that never recorded a base checkpoint never wrote one, so there is nothing to revert —
    // and passing `undefined` through would be read as "wipe the thread", which for a pending run on
    // an established thread would destroy history it never touched.
    if (rollingBack && base.recorded) {
      await rollbackCancelledRun(run, base.checkpointId);
    } else if (options?.wait) {
      // Same wait the rollback path gets for free: the claim frees once the run's engine has unwound.
      // Through the gate too, so `?wait=1` is exact for a run executing on another instance rather than
      // returning immediately on an uncontended local lock.
      await withThreadExecution(
        ctx.executionLocks,
        deps.threadExecutionGate,
        run.thread_id,
        async () => undefined,
      );
    }
    return (await deps.store.runs.get(runId)) ?? { ...run, status: "cancelled" };
  };

  /**
   * The runs a `cancelMany` should act on, narrowest selector first. Explicit ids win outright (a
   * caller naming them means those, whatever their status); otherwise the inflight set of one thread,
   * or of the whole server.
   *
   * `truncated` marks a whole-server sweep that filled the driver's page bound, so the set returned here
   * may be incomplete. Only that form can hit a bound: an explicit id list is exactly what was asked
   * for, and a thread has at most a handful of inflight runs.
   */
  const resolveCancelTargets = async (
    query: CancelManyQuery,
  ): Promise<{ runIds: string[]; truncated: boolean }> => {
    // `runIds !== undefined` is the whole test, **including an empty array**. A caller that sent
    // `run_ids: []` named a set of zero runs; falling through to the whole-server sweep on that would
    // turn "cancel these (none)" into "cancel everything running" — the most destructive possible
    // reading of an empty list, and the natural encoding for a client looping over a filtered array.
    if (query.runIds !== undefined) {
      return { runIds: [...new Set(query.runIds)], truncated: false };
    }
    if (query.threadId !== undefined) await requireThread(query.threadId);
    const inflight = await deps.store.runs.listActiveRuns(query.threadId);
    const wanted =
      query.status === undefined || query.status === "all"
        ? inflight
        : inflight.filter((run) => run.status === query.status);
    // A driver that does not publish its bound simply never reports truncation, rather than having one
    // guessed for it — `maxPageSize` is optional so an existing third-party driver still conforms.
    const pageBound = deps.store.maxPageSize;
    const sweptEverything = query.threadId === undefined;
    return {
      runIds: wanted.map((run) => run.run_id),
      truncated: sweptEverything && pageBound !== undefined && inflight.length >= pageBound,
    };
  };

  /** `POST /runs` — and the unit `POST /runs/batch` repeats. A free function, so `createBatch` need
   * not reach through `this` for it (the service object is routinely destructured). */
  const startStatelessBackgroundRun = async (input: CreateRunInput): Promise<Run> => {
    // `thread_id` is stripped rather than passed through: this is the stateless endpoint, so the thread
    // is the server's to create, and honouring a body-supplied id here would quietly turn `POST /runs`
    // into the thread-scoped endpoint without its 404-on-unknown-thread contract.
    //
    // Which also makes `if_not_exists` inert here: with no named thread there is nothing that could be
    // missing. Left in the input rather than stripped, so the field means the same thing everywhere it
    // is read — `resolveRunThread` ignores it on the undefined-thread branch.
    const { thread_id: _ignored, ...stateless } = input;
    const { run } = await prepareRun(stateless, () => deps.store.threads.create());
    return enqueueBackgroundRun(run, stateless.after_seconds);
  };

  return {
    async createWait(input) {
      const { run, kwargs } = await prepareRun(input, () =>
        resolveRunThread(input.thread_id, input.if_not_exists),
      );
      await holdInlineRun(input.after_seconds);
      const outcome = await runInline(run, kwargs, "wait");
      // A failed run must not read as an empty success. There are no headers left to turn into a
      // status (the run already executed), so the failure travels in the body under `__error__` —
      // the key `@langchain/langgraph-api` uses for exactly this. We match the key but not its
      // double-encoding bug: the payload here is the `RunError` itself, not a JSON string of one.
      const result: WaitRunResult =
        outcome.error !== undefined ? { __error__: outcome.error } : outcome.values;
      return { runId: run.run_id, threadId: run.thread_id, result };
    },

    async createStream(input) {
      const { run, kwargs } = await prepareRun(input, () =>
        resolveRunThread(input.thread_id, input.if_not_exists),
      );
      // Kick off execution; the subscription below replays from seq 0 (frames are buffered), so
      // nothing is lost between starting the run and subscribing. An `after_seconds` delay is awaited
      // *inside* this promise rather than before returning, so the response — and its
      // `Content-Location` — still goes out immediately and the client streams heartbeats until the
      // run actually starts.
      const outcome = holdInlineRun(input.after_seconds)
        .then(() => runInline(run, kwargs, "stream"))
        .catch((error: unknown) => {
          deps.logger.error("stream run failed", error);
          return undefined;
        });
      return {
        runId: run.run_id,
        threadId: run.thread_id,
        frames: deps.bus.subscribe(run.run_id, 0),
        // The outcome, not a re-read of the row — see `StartedStream.finalStatus`. Falls back to the row
        // only when execution rejected outright, which is the one case with no outcome to report.
        finalStatus: async () =>
          (await outcome)?.status ?? (await deps.store.runs.get(run.run_id))?.status ?? null,
      };
    },

    async createBackground(threadId, input) {
      const { run } = await prepareRun({ ...input, thread_id: threadId }, () =>
        resolveRunThread(threadId, input.if_not_exists),
      );
      return enqueueBackgroundRun(run, input.after_seconds);
    },

    createStatelessBackground: startStatelessBackgroundRun,

    async createBatch(inputs) {
      // Sequential, not `Promise.all` (which is what `@langchain/langgraph-api` does): each item
      // creates a thread, a run row and a queue job, so running them concurrently multiplies the
      // store write burst by the batch size for no latency the caller can use — the runs are
      // background work either way. In order, so a failure part-way leaves a comprehensible prefix.
      const created: Run[] = [];
      for (const input of inputs) {
        created.push(await startStatelessBackgroundRun(input));
      }
      return created;
    },

    async get(runId) {
      const run = await deps.store.runs.get(runId);
      if (!run) throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
      return run;
    },

    async listByThread(threadId, query) {
      await requireThread(threadId);
      return deps.store.runs.listByThread(threadId, query);
    },

    cancel: cancelRun,

    async cancelMany(query) {
      const targets = await resolveCancelTargets(query);
      const cancelledRunIds: string[] = [];
      for (const runId of targets.runIds) {
        try {
          await cancelRun(runId, query);
          cancelledRunIds.push(runId);
        } catch (error) {
          // A run that vanished mid-sweep, or one this caller does not own (the auth-scoped store hides
          // it, so `get` 404s), is skipped rather than failing the whole sweep — the request asked to
          // cancel a *set*, and one absent member does not invalidate the rest. Ownership is enforced
          // precisely because each run goes back through the filtered `cancel`.
          if (error instanceof SkeinHttpError && error.status === 404) continue;
          throw error;
        }
      }
      // The whole-server sweep reads a *bounded* page of inflight runs, so "I cancelled everything I
      // saw" is not "everything is cancelled" — say so rather than let a truncated sweep read as a
      // complete one.
      if (targets.truncated) {
        deps.logger.warn(
          `cancelMany cancelled ${cancelledRunIds.length} run(s) and filled the store's page bound — ` +
            `more may still be inflight. Call it again to continue.`,
        );
      }
      return { cancelledRunIds, truncated: targets.truncated };
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
