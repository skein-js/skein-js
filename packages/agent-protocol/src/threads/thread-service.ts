// Thread CRUD + history. State and history are LangGraph-native (read from the checkpointer via a
// graph bound to the thread's `thread_id`); the thread *row* only carries the mirrored latest
// values/status. Deleting a thread first aborts any run still executing on it, so an in-flight run
// can't write to a thread that's about to disappear.

import { Command, type CommandParams, type CompiledGraph } from "@langchain/langgraph";
import {
  isSkeinHttpError,
  isTerminalRunStatus,
  SkeinHttpError,
  type Checkpoint,
  type Metadata,
  type Thread,
  type ThreadCreate,
  type ThreadSearchQuery,
  type ThreadState,
} from "@skein-js/core";

import type { ProtocolContext } from "../context.js";

import { copyCheckpointHistory, pruneThreadCheckpointsToLatest } from "./checkpoint-history.js";
import {
  runStatusForSnapshot,
  snapshotToThreadState,
  snapshotToThreadUpdate,
} from "./thread-mirror.js";

/**
 * One update inside a superstep: the values a node produced, or a command, attributed to `as_node`.
 *
 * `values` and `command` are alternatives — LangGraph carries a command in the same slot as values, so
 * a command wins when both are given (matching `@langchain/langgraph-api`).
 */
export interface SuperstepUpdate {
  values?: unknown;
  command?: { resume?: unknown; update?: unknown; goto?: unknown };
  /** Required: a superstep write has to be attributed to some node. */
  as_node: string;
}

/** A superstep — one tick of the graph, applying its updates together. */
export interface Superstep {
  updates: SuperstepUpdate[];
}

export interface CreateThreadInput {
  thread_id?: string;
  metadata?: Metadata;
  /**
   * What to do when `thread_id` is already taken — LangGraph's `if_exists`, defaulting to `raise`
   * (409). `do_nothing` returns the **existing** thread untouched, which is what makes
   * `threads.create({ threadId: stableKey, ifExists: "do_nothing" })` a get-or-create.
   */
  ifExists?: "raise" | "do_nothing";
  /**
   * Seed the new thread's state by replaying these supersteps into its checkpoint history — how you
   * import an existing conversation rather than replaying it through the graph.
   *
   * Needs a graph to write against, and a brand-new thread has no run to infer one from, so
   * `metadata.graph_id` must be set (the SDK folds `graphId` into metadata for exactly this). Without
   * it this is a 400.
   */
  supersteps?: Superstep[];
}

export interface PatchThreadInput {
  metadata?: Metadata;
}

export interface HistoryOptions {
  /** Checkpoints to return, newest first. Defaults to {@link DEFAULT_THREAD_HISTORY_LIMIT}. */
  limit?: number;
  /**
   * Read the history before this checkpoint, for paging back through a long thread. Structurally a
   * `RunnableConfig` — spelled out here so this package need not depend on `@langchain/core` directly.
   */
  before?: { configurable?: Record<string, unknown> };
  /** Keep only checkpoints whose metadata matches. */
  filter?: Record<string, unknown>;
}

/**
 * Checkpoints `POST /threads/{id}/history` returns when the caller names no limit.
 *
 * Much smaller than the store's page bound: an element here is a checkpoint's **entire graph state**,
 * not a row, and the response holds every one of them plus the serialized string at the same time. A
 * long-lived thread has thousands of checkpoints, so "all of them" was never a sensible default — and
 * the LangGraph SDK itself asks for 10.
 *
 * Not derived from `SKEIN_MAX_PAGE_SIZE`: history is read from the checkpointer, not the store, so the
 * store's page bound does not apply to it.
 */
export const DEFAULT_THREAD_HISTORY_LIMIT = 100;

/** Body of `POST /threads/{id}/state` — a time-travel update that forks a new checkpoint. */
export interface UpdateStateInput {
  /** New state to write. `null`/`undefined` re-points `next` without changing values. */
  values?: unknown;
  /** Attribute the update as though this node produced `values` (sets up which node runs next). */
  as_node?: string;
  /** The checkpoint to fork from; omitted updates the thread tip. */
  checkpoint_id?: string;
  /** Full checkpoint pointer to fork from (alternative to `checkpoint_id`). */
  checkpoint?: Record<string, unknown>;
}

/** Body of `POST /threads/prune`. */
export interface PruneThreadsInput {
  threadIds: string[];
  /**
   * `"delete"` (the default, and the SDK's) removes the threads outright. `"keep_latest"` keeps each
   * thread and its current state, discarding only the checkpoint history behind it.
   */
  strategy?: "delete" | "keep_latest";
}

export interface ThreadService {
  create(input?: CreateThreadInput): Promise<Thread>;
  get(threadId: string): Promise<Thread>;
  list(): Promise<Thread[]>;
  /** Filtered + paginated listing — `POST /threads/search`. */
  search(query: ThreadSearchQuery): Promise<Thread[]>;
  /** How many threads match the filters, ignoring pagination — `POST /threads/count`. */
  count(query: ThreadSearchQuery): Promise<number>;
  /**
   * Bulk-remove threads or their history — `POST /threads/prune`. Returns how many threads were
   * actually changed; an unknown (or non-owned) id is skipped rather than failing the request.
   */
  prune(input: PruneThreadsInput): Promise<{ pruned_count: number }>;
  patch(threadId: string, patch: PatchThreadInput): Promise<Thread>;
  /** Duplicate a thread (new id) together with its full checkpoint history — `POST /threads/{id}/copy`. */
  copy(threadId: string): Promise<Thread>;
  delete(threadId: string): Promise<void>;
  history(threadId: string, options?: HistoryOptions): Promise<ThreadState[]>;
  /** The thread's current state snapshot — `GET /threads/{id}/state`, what `useStream` hydrates from. */
  getState(threadId: string): Promise<ThreadState>;
  /**
   * State at a specific checkpoint (time travel) — `GET /threads/{id}/state/{checkpoint_id}` and its
   * body-shaped sibling `POST /threads/{id}/state/checkpoint`.
   *
   * `checkpointNs` selects a **subgraph**'s namespace and defaults to the root graph (`""`). It scopes
   * *within* the already-resolved thread, so unlike `thread_id` it is safe to take from the client.
   */
  getStateAt(threadId: string, checkpointId: string, checkpointNs?: string): Promise<ThreadState>;
  /**
   * Update (fork) thread state at a checkpoint — `POST /threads/{id}/state`. Writes a new checkpoint
   * via `graph.updateState`, mirrors it onto the thread row, and returns the new checkpoint pointer.
   */
  updateState(threadId: string, input: UpdateStateInput): Promise<{ checkpoint: Checkpoint }>;
}

/**
 * The state of a thread with no checkpoint yet (created but never run). A fresh object per call —
 * never a shared constant — so a caller mutating the result can't corrupt later reads. The
 * checkpoint carries the real `thread_id` to match what LangGraph returns for an empty thread.
 */
function emptyThreadState(threadId: string): ThreadState {
  return {
    values: {},
    next: [],
    checkpoint: {
      thread_id: threadId,
      checkpoint_ns: "",
      checkpoint_id: undefined,
      checkpoint_map: undefined,
    },
    metadata: {},
    created_at: null,
    parent_checkpoint: null,
    tasks: [],
  };
}

export function createThreadService(ctx: ProtocolContext): ThreadService {
  const { deps, control } = ctx;

  const requireThread = async (threadId: string): Promise<Thread> => {
    const thread = await deps.store.threads.get(threadId);
    if (!thread) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
    return thread;
  };

  // Resolve the graph that owns a thread's state — built from the thread's latest run so its shape
  // (and any factory config) matches how it actually ran, with the checkpointer attached so state
  // reads/writes hit this thread's checkpoints (as the engine does). 404s an unknown thread; returns
  // undefined when the thread exists but has no resolvable run/graph yet (never run). The shared load
  // path behind history, state reads, and state updates so all three stay consistent.
  // Build a graph by id with the checkpointer attached, so state reads/writes hit this thread's
  // checkpoints. `resolveConfigurable` is only consulted for a *factory* graph — it is what lets the
  // caller avoid loading a run's kwargs for a graph that would not use them.
  const buildGraph = async (
    graphId: string,
    resolveConfigurable?: () => Promise<Record<string, unknown> | undefined>,
  ): Promise<CompiledGraph<string>> => {
    const resolved = await deps.graphs.load(graphId);
    // A factory graph must be built with the same `configurable` the run engine uses, so a graph whose
    // shape depends on run config is reconstructed identically here.
    const graph =
      typeof resolved === "function"
        ? await resolved({ configurable: await resolveConfigurable?.() })
        : resolved;
    (graph as { checkpointer?: unknown }).checkpointer = deps.checkpointer;
    return graph;
  };

  const loadThreadGraph = async (threadId: string): Promise<CompiledGraph<string> | undefined> => {
    const thread = await requireThread(threadId);
    const runs = await deps.store.runs.listByThread(threadId);
    const latest = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (latest) {
      const assistant = await deps.store.assistants.get(latest.assistant_id);
      if (assistant) {
        return buildGraph(assistant.graph_id, async () => {
          const kwargs = await deps.store.runs.getKwargs(latest.run_id);
          return kwargs?.config?.configurable;
        });
      }
    }
    // No run to infer the graph from — fall back to the thread's own `graph_id`. A thread seeded by
    // `supersteps` at creation has state but has never run, and without this its state would read back
    // empty: the write would land in the checkpointer with nothing able to open it again. The run is
    // still preferred where there is one, because only it can rebuild a factory graph with the same
    // `configurable` the engine used.
    const graphId = thread.metadata?.["graph_id"];
    return typeof graphId === "string" && graphId.length > 0 ? buildGraph(graphId) : undefined;
  };

  // History lives in the checkpointer; read it through the graph of the thread's latest run.
  // `getStateHistory` yields newest-first, so element 0 is the thread's current state.
  const readHistory = async (
    threadId: string,
    options?: HistoryOptions,
  ): Promise<ThreadState[]> => {
    const graph = await loadThreadGraph(threadId);
    if (!graph) return [];

    const states: ThreadState[] = [];
    const limit = options?.limit ?? DEFAULT_THREAD_HISTORY_LIMIT;
    // The limit goes *into* `getStateHistory`, not just into a `break`. `PostgresSaver.list` only emits
    // a SQL `LIMIT` when it is given one, and otherwise runs a single query that materializes every
    // checkpoint row — including its `channel_values` — before yielding the first snapshot. Breaking out
    // of the loop afterwards therefore saves nothing at all: the heap has already taken the whole
    // history. The `break` stays as a backstop for a checkpointer that ignores the option.
    for await (const snapshot of graph.getStateHistory(
      { configurable: { thread_id: threadId } },
      {
        limit,
        ...(options?.before ? { before: options.before } : {}),
        ...(options?.filter ? { filter: options.filter } : {}),
      },
    )) {
      states.push(snapshotToThreadState(snapshot));
      if (states.length >= limit) break;
    }
    return states;
  };

  /**
   * Seed a freshly created thread's state from `supersteps` — `POST /threads` with a body the SDK's
   * `threads.create({ supersteps })` sends. Importing a conversation, rather than replaying it.
   *
   * The graph comes from `metadata.graph_id`, because a thread this new has no run to infer one from
   * ({@link loadThreadGraph} returns undefined for it). That is the same source
   * `@langchain/langgraph-api` reads, and the same 400 when it is missing.
   *
   * Writes through LangGraph's own `bulkUpdateState` rather than looping `updateState`: `updateState`
   * is itself a one-superstep wrapper over it, so this is the same code path skein's time-travel fork
   * already uses, and a multi-update superstep stays *one* tick rather than becoming several.
   */
  const applySupersteps = async (thread: Thread, supersteps: Superstep[]): Promise<void> => {
    const graphId = thread.metadata?.["graph_id"];
    if (typeof graphId !== "string" || graphId.length === 0) {
      throw SkeinHttpError.badRequest(
        `Thread "${thread.thread_id}" has no graph_id, so supersteps cannot be applied. ` +
          `Pass graphId (the SDK folds it into metadata) when creating a thread with supersteps.`,
      );
    }
    const graph = await buildGraph(graphId);
    const configurable = { thread_id: thread.thread_id, checkpoint_ns: "" };
    await graph.bulkUpdateState(
      { configurable },
      supersteps.map((superstep) => ({
        updates: superstep.updates.map((update) => ({
          // A command travels in the `values` slot — LangGraph reads a `Command` there and applies it
          // instead of writing raw values. Same conversion the run engine's `toGraphInput` does.
          values: update.command ? new Command(update.command as CommandParams) : update.values,
          asNode: update.as_node,
        })),
      })),
    );
    // Mirror the seeded state onto the thread row, so a plain `GET /threads/{id}` and `useStream`
    // reflect it without waiting for a first run — the same mirror `updateState` does after a fork.
    const snapshot = await graph.getState({ configurable: { thread_id: thread.thread_id } });
    await deps.store.threads.update(
      thread.thread_id,
      snapshotToThreadUpdate(snapshot, runStatusForSnapshot(snapshot)),
    );
  };

  /** Delete a thread, stopping anything still executing on it first. A local so `prune` can reuse it
   * without reaching through `this` (the service object is routinely destructured). */
  const deleteThread = async (threadId: string): Promise<void> => {
    await requireThread(threadId);
    // Abort any run still executing on this thread before the rows disappear.
    const runs = await deps.store.runs.listByThread(threadId);
    for (const run of runs) {
      if (!isTerminalRunStatus(run.status)) {
        control.abort(run.run_id, "cancel");
        await deps.bus.close(run.run_id);
      }
    }
    await deps.store.threads.delete(threadId);
  };

  return {
    async create(input) {
      const { ifExists, supersteps, ...create } = input ?? {};
      // Atomic if_exists: let the store enforce uniqueness (it throws 409 on a duplicate id) rather
      // than a racy get-then-create. do_nothing recovers the existing row; raise re-throws the 409.
      // The recovering read goes back through `deps.store`, so under auth it is the ownership-scoped
      // one — a thread belonging to another principal still reads as absent rather than being handed
      // back here.
      let thread: Thread;
      try {
        thread = await deps.store.threads.create(create as ThreadCreate);
      } catch (error) {
        if (
          create.thread_id !== undefined &&
          ifExists === "do_nothing" &&
          isSkeinHttpError(error) &&
          error.status === 409
        ) {
          const existing = await deps.store.threads.get(create.thread_id);
          if (!existing) throw error;
          thread = existing;
        } else {
          throw error;
        }
      }

      // Applied after the create, and applied to a thread `do_nothing` merely *found* as well as to
      // one it made — matching `@langchain/langgraph-api`, which runs its `state.bulk` on whatever
      // `put` returned. Surprising enough to be worth stating: a get-or-create carrying supersteps
      // appends to an existing conversation rather than skipping the write.
      if (supersteps && supersteps.length > 0) {
        await applySupersteps(thread, supersteps);
        // Re-read so the response carries the seeded values/status rather than the pre-write row.
        return (await deps.store.threads.get(thread.thread_id)) ?? thread;
      }
      return thread;
    },

    get: requireThread,

    list: () => deps.store.threads.list(),

    search: (query) => deps.store.threads.search(query),

    count: (query) => deps.store.threads.count(query),

    async prune({ threadIds, strategy = "delete" }) {
      let prunedCount = 0;
      const busyThreadIds: string[] = [];
      for (const threadId of new Set(threadIds)) {
        // A thread that is gone — or that this caller does not own, which the auth-scoped store makes
        // indistinguishable from gone — is skipped, not counted, and never 404s the batch. That is what
        // keeps the count from doubling as an existence oracle for another owner's threads.
        const thread = await deps.store.threads.get(threadId);
        if (!thread) continue;

        if (strategy === "delete") {
          await deleteThread(threadId);
          prunedCount += 1;
          continue;
        }

        // keep_latest rewrites the checkpoint tip, so it must not race a run mid-write (the same reason
        // `updateState` refuses on a busy thread). **Skipped, not thrown**: this is a bulk endpoint that
        // has already irreversibly trimmed the threads before this one, and a 409 carries no body — so
        // throwing would leave the caller unable to learn what was destroyed, with a naive retry
        // re-running the whole list. Skipping keeps the contract every other branch here has: a thread
        // that could not be pruned is simply not counted.
        if (await deps.store.runs.hasActiveRun(threadId)) {
          busyThreadIds.push(threadId);
          continue;
        }
        if (await pruneThreadCheckpointsToLatest(deps.checkpointer, threadId)) prunedCount += 1;
      }
      if (busyThreadIds.length > 0) {
        // Logged rather than silent: the count already tells the caller these were not pruned, but an
        // operator retrying a prune needs to know *why* some ids keep not being counted.
        deps.logger.warn(
          `prune skipped ${busyThreadIds.length} busy thread(s); a keep_latest prune cannot run while a ` +
            `thread has an active run. Retry once they settle: ${busyThreadIds.slice(0, 10).join(", ")}`,
        );
      }
      return { pruned_count: prunedCount };
    },

    async patch(threadId, patch) {
      await requireThread(threadId);
      return deps.store.threads.update(threadId, { metadata: patch.metadata });
    },

    async copy(threadId) {
      await requireThread(threadId);
      const copy = await deps.store.threads.copy(threadId);
      await copyCheckpointHistory(deps.checkpointer, threadId, copy.thread_id);
      // Re-create the source's *terminal* runs under the copy (new ids, same assistant/kwargs/status).
      // skein resolves a thread's graph from its latest run, so without these the copied checkpoints
      // would be unreadable via getState/history — and the copy couldn't be resumed or continued. We
      // deliberately skip a still-inflight (pending/running) run: copying it would leave the copy with
      // a phantom active run that no worker drives and no engine finalizes, permanently blocking new
      // runs on the copy (hasActiveRun) and pinning its thread status to busy.
      const sourceRuns = await deps.store.runs.listByThread(threadId);
      for (const run of [...sourceRuns].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
        if (!isTerminalRunStatus(run.status)) continue;
        const kwargs = await deps.store.runs.getKwargs(run.run_id);
        await deps.store.runs.create({
          thread_id: copy.thread_id,
          assistant_id: run.assistant_id,
          status: run.status,
          metadata: run.metadata,
          multitask_strategy: run.multitask_strategy,
          ...(kwargs ? { kwargs } : {}),
        });
      }
      // The copy has no run of its own in flight, so a source that was mid-run ("busy") must not
      // carry that status over — reset it to idle so the copy isn't stuck looking active.
      if (copy.status === "busy") {
        return deps.store.threads.update(copy.thread_id, { status: "idle" });
      }
      return copy;
    },

    delete: deleteThread,

    history: readHistory,

    async getState(threadId) {
      const [current] = await readHistory(threadId, { limit: 1 });
      return current ?? emptyThreadState(threadId);
    },

    async getStateAt(threadId, checkpointId, checkpointNs = "") {
      const graph = await loadThreadGraph(threadId);
      if (!graph) return emptyThreadState(threadId);
      // An unknown checkpoint yields an empty snapshot from LangGraph rather than throwing.
      const snapshot = await graph.getState({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: checkpointId,
        },
      });
      return snapshotToThreadState(snapshot);
    },

    async updateState(threadId, input) {
      // Ownership-gate first: loadThreadGraph 404s an unknown/foreign thread (via requireThread) before
      // any activity check, so a non-owned thread reads as absent (never a 409-vs-404 activity oracle),
      // and 422s a thread that has never produced a graph.
      const graph = await loadThreadGraph(threadId);
      if (!graph) {
        throw SkeinHttpError.unprocessable(`Thread "${threadId}" has no graph to update state on.`);
      }
      // Forking rewrites the checkpoint tip, so it must not race a run mid-write (LangGraph 409).
      if (await deps.store.runs.hasActiveRun(threadId)) {
        throw SkeinHttpError.conflict(
          `Thread "${threadId}" is busy; wait for its active run to finish before updating state.`,
        );
      }
      // Server-owned identity is forced LAST so a client-supplied `checkpoint` object can never
      // redirect the write to another thread — belt-and-suspenders with checkpointSchema, which
      // already strips unknown keys. Only checkpoint_id/ns/map are honored from the client.
      const configurable: Record<string, unknown> = {
        checkpoint_ns: "",
        ...(input.checkpoint ?? {}),
        ...(input.checkpoint_id !== undefined ? { checkpoint_id: input.checkpoint_id } : {}),
        thread_id: threadId,
      };
      const nextConfig = await graph.updateState({ configurable }, input.values, input.as_node);
      // Mirror the fork tip (values + interrupts/status) onto the thread row so a plain
      // `GET /threads/{id}` and `useStream` reflect the branch, as LangGraph does post-update.
      const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
      await deps.store.threads.update(
        threadId,
        snapshotToThreadUpdate(snapshot, runStatusForSnapshot(snapshot)),
      );
      const next = (nextConfig.configurable ?? {}) as Record<string, unknown>;
      const checkpoint: Checkpoint = {
        thread_id: threadId,
        checkpoint_ns: (next["checkpoint_ns"] as string | undefined) ?? "",
        checkpoint_id: next["checkpoint_id"] as string | undefined,
        checkpoint_map: next["checkpoint_map"] as Record<string, unknown> | undefined,
      };
      return { checkpoint };
    },
  };
}
