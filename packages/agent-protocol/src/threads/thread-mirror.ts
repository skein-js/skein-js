// Pure derivation of a thread row update from a LangGraph state snapshot. After a run, the graph's
// authoritative state (values + pending interrupts) is mirrored onto the thread row so a plain
// `GET /threads/{id}` reflects the latest turn without touching the checkpointer. Mirrors what
// `@langchain/langgraph-api` does on `Threads.setStatus`: interrupts are keyed by task id, and a
// non-empty `next` means the graph paused for a human (interrupted).

import type { StateSnapshot } from "@langchain/langgraph";
import type {
  Checkpoint,
  DefaultValues,
  Interrupt,
  Metadata,
  RunStatus,
  ThreadState,
  ThreadTask,
  ThreadUpdate,
} from "@skein-js/core";

import { threadStatusForRun } from "../runs/run-status.js";

/** True if the graph paused with work still to do — i.e. it hit an interrupt and awaits resume. */
export function isInterruptedSnapshot(snapshot: StateSnapshot): boolean {
  return snapshot.next.length > 0;
}

/**
 * Pending interrupts keyed by the task that raised them, matching the wire `Thread.interrupts`
 * shape. LangGraph's runtime `Interrupt` (`{ id?, value? }`) is structurally carried through as the
 * wire type — clients read `value` (and `id`); the extra `when` the SDK type names is not populated
 * by the platform either.
 */
export function collectInterrupts(snapshot: StateSnapshot): Record<string, Interrupt[]> {
  const byTask: Record<string, Interrupt[]> = {};
  for (const task of snapshot.tasks) {
    if (task.interrupts && task.interrupts.length > 0) {
      byTask[task.id] = task.interrupts as unknown as Interrupt[];
    }
  }
  return byTask;
}

/** The terminal run status implied by a completed stream: `interrupted` if it paused, else success. */
export function runStatusForSnapshot(snapshot: StateSnapshot): RunStatus {
  return isInterruptedSnapshot(snapshot) ? "interrupted" : "success";
}

/** Build the thread patch that mirrors a snapshot for a run that ended in `runStatus`. */
export function snapshotToThreadUpdate(
  snapshot: StateSnapshot,
  runStatus: RunStatus,
): ThreadUpdate {
  return {
    values: snapshot.values as DefaultValues,
    interrupts: collectInterrupts(snapshot),
    status: threadStatusForRun(runStatus),
  };
}

/** The checkpoint coordinates carried in a snapshot's `configurable`, or null if not checkpointed. */
function toCheckpoint(config: StateSnapshot["config"] | undefined): Checkpoint | null {
  const configurable = config?.configurable;
  if (!configurable) return null;
  const threadId = configurable["thread_id"];
  if (typeof threadId !== "string") return null;
  return {
    thread_id: threadId,
    checkpoint_ns: (configurable["checkpoint_ns"] as string | undefined) ?? "",
    checkpoint_id: configurable["checkpoint_id"] as string | undefined,
    checkpoint_map: configurable["checkpoint_map"] as Record<string, unknown> | undefined,
  };
}

function toThreadTask(task: StateSnapshot["tasks"][number]): ThreadTask {
  return {
    id: task.id,
    name: task.name,
    result: task.result,
    error: task.error === undefined ? null : String(task.error),
    interrupts: (task.interrupts ?? []) as unknown as Interrupt[],
    checkpoint: null,
    state: null,
  };
}

/** Map a LangGraph state snapshot to the wire {@link ThreadState} used by `/threads/{id}/history`. */
export function snapshotToThreadState(snapshot: StateSnapshot): ThreadState {
  return {
    values: snapshot.values as DefaultValues,
    next: [...snapshot.next],
    checkpoint: toCheckpoint(snapshot.config) ?? {
      thread_id: "",
      checkpoint_ns: "",
      checkpoint_id: undefined,
      checkpoint_map: undefined,
    },
    metadata: (snapshot.metadata ?? {}) as Metadata,
    created_at: snapshot.createdAt ?? null,
    parent_checkpoint: toCheckpoint(snapshot.parentConfig),
    tasks: snapshot.tasks.map(toThreadTask),
  };
}
