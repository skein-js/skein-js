// The Agent Protocol wire contract. We do NOT define these shapes — they are the types the
// official `@langchain/langgraph-sdk` client sends and expects, so re-exporting them here is
// what keeps skein-js wire-compatible (the SDK is the conformance oracle — see docs/reuse.md).
// Everything in skein-js that touches the wire imports the protocol types from `@skein-js/core`,
// never from the SDK directly, so there is a single seam to pin the protocol version.

import type { Cron, Run as SdkRun } from "@langchain/langgraph-sdk";

import type { RunError } from "../errors/run-error.js";

export type {
  Assistant,
  AssistantBase,
  AssistantGraph,
  AssistantVersion,
  Checkpoint,
  Config,
  Cron,
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

// The two create-response shapes, re-exported so a client typed against them still compiles.
// skein answers *every* cron endpoint with the full `Cron`, which satisfies both structurally: they
// are narrower legacy shapes that disagree with `Cron` on nullability (each types `user_id` as a
// required string where `Cron.user_id` is `Optional<string>`), so `Cron` is the authority here.
export type { CronCreateForThreadResponse, CronCreateResponse } from "@langchain/langgraph-sdk";

// `CronSortBy` and `CronSelectField` are declared in the SDK's schema module but not re-exported
// from its root barrel, so — as with `RunStatus` above — we restate them here rather than reach past
// the package's public surface. `Extract` over `keyof Cron` rather than a free-standing literal
// union: every sort key is a real field of the row being sorted, so tying them together is what
// keeps this honest if the SDK ever renames one.
export type CronSortBy = Extract<
  keyof Cron,
  "cron_id" | "assistant_id" | "thread_id" | "created_at" | "updated_at" | "next_run_date"
>;

/**
 * Field projection for `POST /runs/crons/search`. Every member is a `Cron` field except `"now"`, a
 * pseudo-field the SDK accepts and whose server-side meaning LangGraph does not document — so skein
 * validates the whole projection and then ignores it, rather than inventing semantics for it.
 */
export type CronSelectField =
  | Extract<
      keyof Cron,
      | "cron_id"
      | "assistant_id"
      | "thread_id"
      | "end_time"
      | "schedule"
      | "created_at"
      | "updated_at"
      | "user_id"
      | "payload"
      | "next_run_date"
      | "metadata"
      | "timezone"
      | "enabled"
      | "on_run_completed"
    >
  | "now";

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
