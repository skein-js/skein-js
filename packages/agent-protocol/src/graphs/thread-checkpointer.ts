// The checkpointer surface skein calls, named structurally rather than by importing a runtime's class.
//
// `ProtocolDeps.checkpointer` was typed `BaseCheckpointSaver`, an **abstract class** from
// `@langchain/langgraph`. Two consequences, both of which this type removes:
//
//   1. A hand-written stand-in could not satisfy it — you cannot structurally implement an abstract
//      class with private/protected members, so a non-LangGraph deployment had to cast. That cast was
//      one of exactly two the phase-1 measurement found (docs/proposals/standalone-agent-protocol.md).
//   2. It put `@langchain/langgraph` in this package's generated `.d.ts`, so "install
//      `@skein-js/agent-protocol` and implement `AgentGraph` yourself" did not typecheck without the
//      graph runtime present — the runtime graph was clean, the type graph was not.
//
// `BaseCheckpointSaver` satisfies this by construction (asserted in `thread-checkpointer.test.ts`), so
// widening `ProtocolDeps.checkpointer` to it is additive.
//
// Deliberately NOT an abstraction over checkpointing. It names the five operations skein performs and
// nothing else; the checkpoint payload itself stays opaque, because skein never inspects it beyond an
// id and the channel versions it has to echo back on a re-put.

/** A checkpoint, as far as skein is concerned: an id, plus whatever the runtime keeps in it. */
export interface ThreadCheckpointRecord {
  readonly id: string;
  /** Echoed back on a re-put. Opaque — skein neither reads nor derives versions. */
  readonly channel_versions?: unknown;
}

/** One checkpoint plus the coordinates needed to re-put it. Accepts LangGraph's `CheckpointTuple`. */
export interface ThreadCheckpointTuple {
  readonly config: { configurable?: Record<string, unknown> };
  readonly checkpoint: ThreadCheckpointRecord;
  /** Passed through untouched on a re-put. */
  readonly metadata?: unknown;
  readonly parentConfig?: { configurable?: Record<string, unknown> } | undefined;
  /** `[taskId, channel, value]`, regrouped per task when replayed. */
  readonly pendingWrites?: readonly (readonly [string, string, unknown])[] | undefined;
}

/** Options for a history read. `limit` MUST bound at the source, not by breaking out of the loop. */
export interface ThreadCheckpointListOptions {
  limit?: number;
  before?: { configurable?: Record<string, unknown> };
  filter?: Record<string, unknown>;
}

/**
 * What skein calls on a checkpointer: the tip, a bounded history read, and the writes that thread
 * copy / `keep_latest` prune / rollback need.
 */
export interface ThreadCheckpointer {
  getTuple(config: {
    configurable?: Record<string, unknown>;
  }): Promise<ThreadCheckpointTuple | undefined>;

  list(
    config: { configurable?: Record<string, unknown> },
    options?: ThreadCheckpointListOptions,
  ): AsyncIterable<ThreadCheckpointTuple>;

  put(
    config: { configurable?: Record<string, unknown> },
    checkpoint: ThreadCheckpointRecord,
    metadata: unknown,
    newVersions: unknown,
  ): Promise<{ configurable?: Record<string, unknown> }>;

  putWrites(
    config: { configurable?: Record<string, unknown> },
    writes: readonly (readonly [string, unknown])[],
    taskId: string,
  ): Promise<void>;

  deleteThread(threadId: string): Promise<void>;
}
