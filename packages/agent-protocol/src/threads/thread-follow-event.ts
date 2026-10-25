import { serializeWireJson, type ThreadEvent } from "@skein-js/core";

import { encodeFrame } from "../sse/sse.js";

/** Project retained publications onto the legacy thread SSE contract, after visibility checks. */
export function encodeThreadFollowEvent(entry: ThreadEvent, modes: readonly string[]): string[] {
  const encode = (event: string, payload: unknown) =>
    `id: ${entry.seq}\nevent: ${event}\ndata: ${serializeWireJson(payload)}\n\n`;
  if (entry.kind === "state") {
    if (entry.lifecycle && entry.runId)
      return modes.includes("lifecycle") || modes.includes("run_modes")
        ? [
            encode(
              "metadata",
              entry.lifecycle === "start"
                ? { run_id: entry.runId, attempt: 1 }
                : { status: "run_done", run_id: entry.runId },
            ),
          ]
        : [];
    const frames: string[] = [];
    if (modes.includes("state_update") && entry.state)
      frames.push(
        encode("state_update", { thread_id: entry.thread.thread_id, state: entry.state }),
      );
    if (modes.includes("thread_state")) frames.push(encode("thread_state", entry.thread));
    return frames;
  }
  if (entry.kind !== "run") return [];
  const { frame } = entry;
  if (modes.includes("run_modes") || modes.includes(frame.event))
    return [encodeFrame({ ...frame, seq: entry.seq })];
  return [];
}
