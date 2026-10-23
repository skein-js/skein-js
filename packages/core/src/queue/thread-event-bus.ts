import type { Event } from "@langchain/protocol";

import type { Thread } from "../wire/wire.js";

import type { RunFrame } from "./queue.js";

/** Thread-wide event history. Sequence numbers span runs and are assigned by the bus. */
export type ThreadEvent = { seq: number } & (
  | { kind: "protocol"; runId: string; event: Event }
  | { kind: "run"; runId: string; frame: RunFrame }
  | { kind: "state"; operation: "created" | "updated"; thread: Thread }
);

/** The publisher supplies content; only the bus assigns ordering and reconnect identities. */
export type ThreadEventInput = ThreadEvent extends infer Entry
  ? Entry extends ThreadEvent
    ? Omit<Entry, "seq">
    : never
  : never;

/** Optional infrastructure for subscriptions that remain open across multiple runs. */
export interface ThreadEventBus {
  /** Deleted threads reject late publications until an explicit `created` state event. */
  publish(
    threadId: string,
    entry: ThreadEventInput,
    generation?: number,
  ): Promise<ThreadEvent | undefined>;
  /** An incarnation token; capture before execution to reject publications after deletion/id reuse. */
  generation(threadId: string): Promise<number>;
  /** Cursor captured before reading a state baseline, closing the snapshot/live overlap. */
  latestSequence(threadId: string): Promise<number>;
  /** Cursor immediately before retained history, or the current tail when no payloads remain. */
  replayCursor(threadId: string): Promise<number>;
  /** Replay entries after the cursor, then tail. A lost/future cursor throws `thread_cursor_expired`. */
  subscribe(threadId: string, afterSeq?: number, signal?: AbortSignal): AsyncIterable<ThreadEvent>;
  /** Erase payloads, close readers, and prevent a deleted run from recreating its history. */
  deleteThread(threadId: string): Promise<void>;
}
