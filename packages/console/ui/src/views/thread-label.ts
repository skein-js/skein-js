import type { Thread } from "@langchain/langgraph-sdk";
import { ensureMessageInstances } from "@langchain/langgraph-sdk/ui";

/** A display hint from already-returned state, never a persisted title or a graph schema. */
export function describeThread(thread: Pick<Thread, "thread_id" | "values" | "metadata">): string {
  const values = thread.values as { messages?: unknown } | undefined;
  if (Array.isArray(values?.messages)) {
    for (const entry of values.messages) {
      if (!entry || typeof entry !== "object") continue;
      try {
        const message = ensureMessageInstances([entry])[0];
        if (message?.getType() === "human") {
          const text = message.text.replace(/\s+/g, " ").trim();
          if (text) return text.length > 100 ? `${text.slice(0, 100)}…` : text;
        }
      } catch {
        // Arbitrary graph values need not be valid LangChain messages.
      }
    }
  }
  const graph = thread.metadata?.graph_id;
  return `${typeof graph === "string" && graph ? graph : "Thread"} · ${thread.thread_id.slice(0, 8)}`;
}
