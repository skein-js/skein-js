// The Agent Protocol wire contract. We do NOT define these shapes — they are the types the
// official `@langchain/langgraph-sdk` client sends and expects, so re-exporting them here is
// what keeps skein-js wire-compatible (the SDK is the conformance oracle — see docs/reuse.md).
// Everything in skein-js that touches the wire imports the protocol types from `@skein-js/core`,
// never from the SDK directly, so there is a single seam to pin the protocol version.

import type { Run as SdkRun } from "@langchain/langgraph-sdk";

export type {
  Assistant,
  AssistantBase,
  AssistantGraph,
  AssistantVersion,
  Checkpoint,
  Config,
  DefaultValues,
  GraphSchema,
  Interrupt,
  Item,
  Metadata,
  SearchItem,
  StreamMode,
  Thread,
  ThreadState,
  ThreadStatus,
  ThreadTask,
} from "@langchain/langgraph-sdk";

// `RunStatus` and `MultitaskStrategy` aren't re-exported from the SDK root, so we derive them
// from the SDK's `Run` — this stays pinned to the exact wire contract regardless of the SDK's barrel.
//
// One deliberate divergence: we widen `RunStatus` with `"cancelled"`. The SDK union collapses a
// cancelled run onto `"error"`, which makes an explicit cancellation indistinguishable from a
// genuine failure. skein tracks cancellation as its own terminal status so callers can tell the
// two apart; the cancelled thread still mirrors back to `idle`. This is the one place skein steps
// outside the SDK oracle on purpose. Because of it, `Run` is re-exported with the widened status
// rather than passed through verbatim, so every run row skein constructs carries the new status.
export type RunStatus = SdkRun["status"] | "cancelled";
export type Run = Omit<SdkRun, "status"> & { status: RunStatus };
export type MultitaskStrategy = NonNullable<SdkRun["multitask_strategy"]>;
