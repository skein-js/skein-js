// Pure derivation of a thread row update from an agent's state snapshot. After a run, the agent's
// authoritative state (values + pending interrupts) is mirrored onto the thread row so a plain
// `GET /threads/{id}` reflects the latest turn without touching the checkpointer. Mirrors what
// `@langchain/langgraph-api` does on `Threads.setStatus`: interrupts are keyed by task id, and a
// non-empty `next` means the agent paused for a human (interrupted).
//
// Typed against {@link AgentStateSnapshot} rather than LangGraph's `StateSnapshot`: this file is the
// projection onto the wire, and every field it reads is one the structural type already names. A
// `StateSnapshot` is assignable to it, so LangGraph keeps flowing through unchanged.

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

import type { AgentStateSnapshot, AgentStateTask } from "../graphs/agent-graph.js";
import { threadStatusForRun } from "../runs/run-status.js";

/** True if the agent paused with work still to do — i.e. it hit an interrupt and awaits resume. */
export function isInterruptedSnapshot(snapshot: AgentStateSnapshot): boolean {
  return snapshot.next.length > 0;
}

/**
 * Pending interrupts keyed by the task that raised them, matching the wire `Thread.interrupts`
 * shape. A runtime `Interrupt` (`{ id?, value? }`) is carried through as the wire type — clients read
 * `value` (and `id`); the extra `when` the SDK type names is not populated by the platform either.
 */
export function collectInterrupts(snapshot: AgentStateSnapshot): Record<string, Interrupt[]> {
  const byTask: Record<string, Interrupt[]> = {};
  for (const task of snapshot.tasks) {
    if (task.interrupts && task.interrupts.length > 0) {
      byTask[task.id] = [...task.interrupts];
    }
  }
  return byTask;
}

/** The terminal run status implied by a completed stream: `interrupted` if it paused, else success. */
export function runStatusForSnapshot(snapshot: AgentStateSnapshot): RunStatus {
  return isInterruptedSnapshot(snapshot) ? "interrupted" : "success";
}

/** Build the thread patch that mirrors a snapshot for a run that ended in `runStatus`. */
export function snapshotToThreadUpdate(
  snapshot: AgentStateSnapshot,
  runStatus: RunStatus,
): ThreadUpdate {
  return {
    values: snapshot.values as DefaultValues,
    interrupts: collectInterrupts(snapshot),
    status: threadStatusForRun(runStatus),
  };
}

/** The checkpoint coordinates carried in a snapshot's `configurable`, or null if not checkpointed. */
function toCheckpoint(config: AgentStateSnapshot["config"] | undefined): Checkpoint | null {
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

/**
 * A failed task's error, as the wire's `ThreadTask.error` string.
 *
 * LangGraph records a task failure as an *object* (`{ name, message }`), so the obvious `String()`
 * yields `"[object Object]"`. It has to be JSON: the SDK's `useStream` reads this field back with
 * `JSON.parse` and rebuilds a `StreamError` from it when the result carries a `message`, falling
 * back to showing the raw string. `@langchain/langgraph-api` lands on the same JSON by way of its
 * `serializeError`, so this matches the platform on the shape clients actually parse.
 */
function toTaskError(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function toThreadTask(task: AgentStateTask): ThreadTask {
  return {
    id: task.id,
    name: task.name,
    result: task.result,
    error: toTaskError(task.error),
    interrupts: [...(task.interrupts ?? [])],
    checkpoint: null,
    state: null,
  };
}

/** Map an agent state snapshot to the wire {@link ThreadState} used by `/threads/{id}/history`. */
export function snapshotToThreadState(snapshot: AgentStateSnapshot): ThreadState {
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
