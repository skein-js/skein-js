// Best-effort extraction of run activity — tool calls, tool results, and interrupts — from LangGraph
// stream chunks and state snapshots, for the dev server's `--verbose` logging. It must NEVER throw
// (logging can't be allowed to perturb a run) and it stays conservative: it reports only what it can
// positively identify, since chunk shapes differ by stream mode.

import type { StateSnapshot } from "@langchain/langgraph";

/** A tool invocation or result seen in the stream: the tool name and, when present, its call id. */
export interface ToolActivity {
  name: string;
  /** The tool-call id, used to log each call/result once despite streaming duplicates. */
  id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The message type of a LangChain message-like object (`type` field or `_getType()`), if any. */
function messageType(node: Record<string, unknown>): string | undefined {
  if (typeof node["type"] === "string") return node["type"];
  const getType = node["_getType"];
  if (typeof getType === "function") {
    try {
      const type = (getType as () => unknown).call(node);
      return typeof type === "string" ? type : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Scan a stream chunk's data for tool calls (AI-message `tool_calls`) and tool results (`tool`
 * messages), wherever they sit in the shape the current stream mode produced. Depth-bounded and
 * cycle-safe; returns empty arrays for anything it can't read.
 */
export function extractToolActivity(data: unknown): {
  calls: ToolActivity[];
  results: ToolActivity[];
} {
  const calls: ToolActivity[] = [];
  const results: ToolActivity[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || !isRecord(node) || seen.has(node)) return;
    seen.add(node);

    const toolCalls = node["tool_calls"];
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (isRecord(call) && typeof call["name"] === "string" && call["name"].length > 0) {
          calls.push({
            name: call["name"],
            id: typeof call["id"] === "string" ? call["id"] : undefined,
          });
        }
      }
    }

    if (messageType(node) === "tool") {
      results.push({
        name: typeof node["name"] === "string" ? node["name"] : "tool",
        id: typeof node["tool_call_id"] === "string" ? node["tool_call_id"] : undefined,
      });
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
      } else if (isRecord(value)) {
        visit(value, depth + 1);
      }
    }
  };

  try {
    visit(data, 0);
  } catch {
    // Logging must never break a run.
  }
  return { calls, results };
}

/**
 * The node(s) LangGraph was executing when the run threw, read from the post-failure state snapshot.
 *
 * The error object itself never names the node: LangGraph's `PregelRunner` rethrows a node's error
 * verbatim, and its own `NodeError` (which does carry `.node`) is only ever handed to a per-node
 * `errorHandler`, never thrown out of the graph. What the runner *does* do is record an `__error__`
 * write against the failing task, which surfaces on `StateSnapshot.tasks[].error` next to the task's
 * name — so the snapshot taken after the failure is the one reliable source.
 *
 * Best-effort, and honest about it: returns `[]` when the graph failed before any task ran, and
 * names the *parent* node when the failure happened inside a subgraph. Never throws.
 */
export function describeFailingNodes(snapshot: StateSnapshot): string[] {
  const names: string[] = [];
  try {
    for (const task of snapshot.tasks ?? []) {
      if (task.error === undefined || task.error === null) continue;
      if (typeof task.name === "string" && task.name.length > 0) names.push(task.name);
    }
  } catch {
    // best-effort — an unexpected snapshot shape must not break the run.
  }
  return names;
}

/** The interrupt prompts a paused snapshot is waiting on, as short strings (best-effort). */
export function describeInterrupts(snapshot: StateSnapshot): string[] {
  const prompts: string[] = [];
  try {
    for (const task of snapshot.tasks ?? []) {
      for (const interrupt of task.interrupts ?? []) {
        const value = (interrupt as { value?: unknown }).value;
        prompts.push(typeof value === "string" ? value : JSON.stringify(value));
      }
    }
  } catch {
    // best-effort — an unexpected snapshot shape must not break the run.
  }
  return prompts;
}
