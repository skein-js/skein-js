// The Agent Protocol wire contract. We do NOT define these shapes — they are the types the
// official `@langchain/langgraph-sdk` client sends and expects, so re-exporting them here is
// what keeps Skein wire-compatible (the SDK is the conformance oracle — see docs/reuse.md).
// Everything in Skein that touches the wire imports the protocol types from `@skein/core`,
// never from the SDK directly, so there is a single seam to pin the protocol version.

import type { Run } from "@langchain/langgraph-sdk";

export type {
  Assistant,
  AssistantBase,
  AssistantGraph,
  Checkpoint,
  Config,
  DefaultValues,
  GraphSchema,
  Interrupt,
  Item,
  Metadata,
  Run,
  SearchItem,
  StreamMode,
  Thread,
  ThreadState,
  ThreadStatus,
  ThreadTask,
} from "@langchain/langgraph-sdk";

// `RunStatus` and `MultitaskStrategy` aren't re-exported from the SDK root, so we derive them
// from `Run` — this stays pinned to the exact wire contract regardless of the SDK's barrel.
export type RunStatus = Run["status"];
export type MultitaskStrategy = NonNullable<Run["multitask_strategy"]>;
