// The `ProtocolDeps.cloneCheckpoint` implementation for LangGraph.js.

import { copyCheckpoint, type Checkpoint } from "@langchain/langgraph";

/**
 * Deep-enough copy of a checkpoint, delegated to LangGraph's own `copyCheckpoint`.
 *
 * Deliberately not reimplemented: `copyCheckpoint` knows which fields are safe to share and which
 * need copying (`channel_values`, `channel_versions`, `versions_seen`), and reproducing that here
 * would be a fork of a `@langchain/*` export — the thing docs/reuse.md exists to prevent.
 */
export function cloneLangGraphCheckpoint(checkpoint: unknown): unknown {
  return copyCheckpoint(checkpoint as Checkpoint);
}
