// The Agent Protocol wire contract. We do NOT define these shapes — they are the types the
// official `@langchain/langgraph-sdk` client sends and expects, so re-exporting them here is
// what keeps skein-js wire-compatible (the SDK is the conformance oracle — see docs/reuse.md).
// Everything in skein-js that touches the wire imports the protocol types from `@skein-js/core`,
// never from the SDK directly, so there is a single seam to pin the protocol version.

import type { Run as SdkRun } from "@langchain/langgraph-sdk";

import type { RunError } from "../errors/run-error.js";

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
// Two deliberate divergences, both on `Run`, both additive.
//
// 1. We widen `RunStatus` with `"cancelled"`. The SDK union collapses a cancelled run onto
//    `"error"`, which makes an explicit cancellation indistinguishable from a genuine failure.
//    skein tracks cancellation as its own terminal status so callers can tell the two apart; the
//    cancelled thread still mirrors back to `idle`.
// 2. We add an optional `error`. The SDK's `Run` records only *that* a run reached `"error"`, never
//    why — and skein's own answer used to survive on the thread's `metadata.error`, which the next
//    successful run clears. So `GET /threads/{tid}/runs/{rid}` could not explain a failure after the
//    fact. skein persists the failure on the run row itself, as the same `RunError` the `error` SSE
//    frame carries. It is absent on every run that did not fail, so an SDK client that never reads
//    it is unaffected. Its `stack` is populated only when the server sets `exposeErrorStacks`.
//
// These are the only two places skein steps outside the SDK oracle on purpose. Because of them,
// `Run` is re-exported reshaped rather than passed through verbatim, so every run row skein
// constructs carries both.
export type RunStatus = SdkRun["status"] | "cancelled";
export type Run = Omit<SdkRun, "status"> & { status: RunStatus; error?: RunError };
export type MultitaskStrategy = NonNullable<SdkRun["multitask_strategy"]>;
