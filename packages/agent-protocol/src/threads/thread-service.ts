// Thread CRUD + history. State and history are LangGraph-native (read from the checkpointer via a
// graph bound to the thread's `thread_id`); the thread *row* only carries the mirrored latest
// values/status. Deleting a thread first aborts any run still executing on it, so an in-flight run
// can't write to a thread that's about to disappear.

import {
  isTerminalRunStatus,
  SkeinHttpError,
  type Metadata,
  type Thread,
  type ThreadCreate,
  type ThreadState,
} from "@skein-js/core";

import type { ProtocolContext } from "../context.js";

import { snapshotToThreadState } from "./thread-mirror.js";

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

export interface ThreadService {
  create(input?: CreateThreadInput): Promise<Thread>;
  get(threadId: string): Promise<Thread>;
  list(): Promise<Thread[]>;
  patch(threadId: string, patch: PatchThreadInput): Promise<Thread>;
  delete(threadId: string): Promise<void>;
  history(threadId: string, options?: HistoryOptions): Promise<ThreadState[]>;
}

export function createThreadService(ctx: ProtocolContext): ThreadService {
  const { deps, control } = ctx;

  const requireThread = async (threadId: string): Promise<Thread> => {
    const thread = await deps.store.threads.get(threadId);
    if (!thread) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
    return thread;
  };

  return {
    create: (input) => deps.store.threads.create(input as ThreadCreate | undefined),

    get: requireThread,

    list: () => deps.store.threads.list(),

    async patch(threadId, patch) {
      await requireThread(threadId);
      return deps.store.threads.update(threadId, { metadata: patch.metadata });
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

    async history(threadId, options) {
      await requireThread(threadId);
      // History lives in the checkpointer; read it through the graph of the thread's latest run.
      const runs = await deps.store.runs.listByThread(threadId);
      const latest = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!latest) return [];
      const assistant = await deps.store.assistants.get(latest.assistant_id);
      if (!assistant) return [];

      const resolved = await deps.graphs.load(assistant.graph_id);
      const graph = typeof resolved === "function" ? await resolved({}) : resolved;
      // Attach the checkpointer so history reads this thread's checkpoints (as the engine does).
      (graph as { checkpointer?: unknown }).checkpointer = deps.checkpointer;

      const states: ThreadState[] = [];
      const limit = options?.limit;
      for await (const snapshot of graph.getStateHistory({
        configurable: { thread_id: threadId },
      })) {
        states.push(snapshotToThreadState(snapshot));
        if (limit !== undefined && states.length >= limit) break;
      }
      return states;
    },
  };
}
