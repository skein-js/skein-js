import { SkeinHttpError, type RunKwargs } from "@skein-js/core";

import type { AgentGraph, AgentStateSnapshot } from "../graphs/agent-graph.js";
import { collectInterrupts } from "../threads/thread-mirror.js";

/** Resolve only a checkpoint attributable to this attempt, while the caller holds the thread lease. */
export async function resolveRunRecovery(
  graph: AgentGraph,
  runId: string,
  threadId: string,
  kwargs: RunKwargs,
): Promise<AgentStateSnapshot | undefined> {
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  if (snapshot.metadata?.["run_id"] === runId) return snapshot;

  const checkpointId = snapshot.config?.configurable?.["checkpoint_id"];
  // No checkpoint, or the unchanged base of this attempt: input has not durably entered the graph.
  // Work before the first durable checkpoint may repeat; external effects still need idempotency.
  if (checkpointId === undefined || checkpointId === kwargs.base_checkpoint_id) return undefined;
  throw SkeinHttpError.conflict(
    `run_recovery_ambiguous: Cannot safely recover run "${runId}": the current checkpoint is not attributable to this run. ` +
      "Inspect the thread and explicitly choose whether to resume it or submit a new turn.",
    { code: "run_recovery_ambiguous" },
  );
}

/** Do not turn crash recovery into permission to cross a configured human-input boundary. */
export async function preservesRecoveryInterrupt(
  graph: AgentGraph,
  snapshot: AgentStateSnapshot,
  kwargs: RunKwargs,
): Promise<boolean> {
  if (Object.keys(collectInterrupts(snapshot)).length > 0) return true;
  if (snapshot.next.length === 0) return false;
  const before = kwargs.interrupt_before;
  if (before === "*" || snapshot.next.some((node) => before?.includes(node))) return true;
  const after = kwargs.interrupt_after;
  if (after === undefined || snapshot.metadata?.["source"] === "input") return false;
  if (!graph.getStateHistory)
    throw SkeinHttpError.conflict(
      "run_recovery_ambiguous: Cannot safely recover a configured interrupt without checkpoint history.",
      { code: "run_recovery_ambiguous" },
    );
  // The preceding checkpoint names the tasks whose completion produced this checkpoint. Limit at
  // the saver, rather than materializing the thread's history just to preserve a breakpoint.
  let latest = true;
  const historyConfig = {
    configurable: {
      thread_id: snapshot.config?.configurable?.["thread_id"],
      checkpoint_ns: snapshot.config?.configurable?.["checkpoint_ns"] ?? "",
    },
  };
  for await (const previous of graph.getStateHistory(historyConfig, { limit: 2 })) {
    if (latest) {
      latest = false;
      continue;
    }
    return previous.next.some((node) => after === "*" || after.includes(node));
  }
  throw SkeinHttpError.conflict(
    "run_recovery_ambiguous: Cannot safely recover a configured interrupt: its preceding checkpoint is unavailable.",
    { code: "run_recovery_ambiguous" },
  );
}
