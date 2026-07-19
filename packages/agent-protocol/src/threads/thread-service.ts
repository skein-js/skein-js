// Thread CRUD + history. State and history are LangGraph-native (read from the checkpointer via a
// graph bound to the thread's `thread_id`); the thread *row* only carries the mirrored latest
// values/status. Deleting a thread first aborts any run still executing on it, so an in-flight run
// can't write to a thread that's about to disappear.

import type { CompiledGraph } from "@langchain/langgraph";
import {
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

import { copyCheckpointHistory } from "./checkpoint-history.js";
import {
  runStatusForSnapshot,
  snapshotToThreadState,
  snapshotToThreadUpdate,
} from "./thread-mirror.js";

export interface CreateThreadInput {
  thread_id?: string;
  metadata?: Metadata;
}

export interface PatchThreadInput {
  metadata?: Metadata;
}

export interface HistoryOptions {
  limit?: number;
}

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

export interface ThreadService {
  create(input?: CreateThreadInput): Promise<Thread>;
  get(threadId: string): Promise<Thread>;
  list(): Promise<Thread[]>;
  /** Filtered + paginated listing — `POST /threads/search`. */
  search(query: ThreadSearchQuery): Promise<Thread[]>;
  patch(threadId: string, patch: PatchThreadInput): Promise<Thread>;
  /** Duplicate a thread (new id) together with its full checkpoint history — `POST /threads/{id}/copy`. */
  copy(threadId: string): Promise<Thread>;
  delete(threadId: string): Promise<void>;
  history(threadId: string, options?: HistoryOptions): Promise<ThreadState[]>;
  /** The thread's current state snapshot — `GET /threads/{id}/state`, what `useStream` hydrates from. */
  getState(threadId: string): Promise<ThreadState>;
  /** State at a specific checkpoint (time travel) — `GET /threads/{id}/state/{checkpoint_id}`. */
  getStateAt(threadId: string, checkpointId: string): Promise<ThreadState>;
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
  const loadThreadGraph = async (threadId: string): Promise<CompiledGraph<string> | undefined> => {
    await requireThread(threadId);
    const runs = await deps.store.runs.listByThread(threadId);
    const latest = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!latest) return undefined;
    const assistant = await deps.store.assistants.get(latest.assistant_id);
    if (!assistant) return undefined;

    const resolved = await deps.graphs.load(assistant.graph_id);
    // A factory graph must be built with the run's `configurable` — same as the run engine — so a
    // graph whose shape depends on run config is reconstructed identically for the state read.
    let graph: CompiledGraph<string>;
    if (typeof resolved === "function") {
      const kwargs = await deps.store.runs.getKwargs(latest.run_id);
      graph = await resolved({ configurable: kwargs?.config?.configurable });
    } else {
      graph = resolved;
    }
    (graph as { checkpointer?: unknown }).checkpointer = deps.checkpointer;
    return graph;
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
    const limit = options?.limit;
    for await (const snapshot of graph.getStateHistory({
      configurable: { thread_id: threadId },
    })) {
      states.push(snapshotToThreadState(snapshot));
      if (limit !== undefined && states.length >= limit) break;
    }
    return states;
  };

  return {
    create: (input) => deps.store.threads.create(input as ThreadCreate | undefined),

    get: requireThread,

    list: () => deps.store.threads.list(),

    search: (query) => deps.store.threads.search(query),

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

    async delete(threadId) {
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
    },

    history: readHistory,

    async getState(threadId) {
      const [current] = await readHistory(threadId, { limit: 1 });
      return current ?? emptyThreadState(threadId);
    },

    async getStateAt(threadId, checkpointId) {
      const graph = await loadThreadGraph(threadId);
      if (!graph) return emptyThreadState(threadId);
      // An unknown checkpoint yields an empty snapshot from LangGraph rather than throwing.
      const snapshot = await graph.getState({
        configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: checkpointId },
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
