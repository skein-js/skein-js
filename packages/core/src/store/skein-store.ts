// `SkeinStore` — the durable home for Agent Protocol *resources* (assistants, threads, runs,
// long-term store items). This is deliberately NOT LangGraph's checkpointer: graph state and
// history stay 100% LangGraph-native via a `BaseCheckpointSaver`. SkeinStore owns only the
// resource rows that OSS keeps in memory (see docs/storage.md).
//
// Every driver (memory, postgres, …) implements this one interface and is held to the shared
// conformance suite, so they behave identically. Methods return the wire types from
// `../wire`, so a handler can pass a repo result straight to the client.
//
// The per-resource contracts live in sibling modules — one file per resource, the same
// layout-by-feature rule the rest of the codebase follows. This module is the composition point:
// the aggregate interface, the snapshot format, and a re-export of every part, so a consumer has
// one import site regardless of which file a type happens to live in.

import type { Assistant, AssistantVersion, Cron, Item, Run, Thread } from "../wire/wire.js";

import type { AssistantRepo } from "./assistants.js";
import type { CronRepo } from "./crons.js";
import type { DeliveryRepo } from "./deliveries.js";
import type { IdempotencyRepo } from "./idempotency.js";
import type { RunKwargs, RunRepo } from "./runs.js";
import type { StoreRepo } from "./store-items.js";
import type { ThreadRepo } from "./threads.js";

export * from "./assistants.js";
export * from "./crons.js";
export * from "./deliveries.js";
export * from "./idempotency.js";
export * from "./metadata-match.js";
export * from "./pagination.js";
export * from "./runs.js";
export * from "./store-items.js";
export * from "./threads.js";

/** The single persistence seam for Agent Protocol resources. One implementation per driver. */
export interface SkeinStore {
  assistants: AssistantRepo;
  threads: ThreadRepo;
  runs: RunRepo;
  crons: CronRepo;
  store: StoreRepo;
  idempotency: IdempotencyRepo;
  /**
   * Outbound run-completion callbacks — the outbox behind the `webhook` field on run creation.
   *
   * Optional so an existing third-party driver still satisfies the interface, like {@link durable}.
   * Absent means the pre-outbox behaviour: one best-effort POST, logged on failure and never retried.
   * Both bundled drivers provide it, and a driver that provides this must also implement
   * {@link RunRepo.finalizeWithDelivery} — one without the other cannot make a delivery durable.
   */
  deliveries?: DeliveryRepo;
  /**
   * Whether rows written here survive a process restart.
   *
   * Only crons consult it, and only to warn: every other resource is created by a caller who finds
   * out it is gone the next time they look, whereas a *schedule* is expected to keep firing while
   * nobody is watching. A memory-backed cron in a long-lived server is silently erased by every
   * deploy, and a schedule that quietly stops is worse than one that was never created — so the
   * scheduler says so once at startup rather than letting it be discovered later.
   *
   * Optional so an existing third-party driver still satisfies the interface; absent is read as
   * "unknown", which does not warn. Both bundled drivers set it.
   */
  readonly durable?: boolean;
  /**
   * The page bound this driver applies to an unbounded read (see {@link DEFAULT_MAX_PAGE_SIZE}).
   *
   * Exposed so a caller can tell a *complete* result from a truncated one. Without it the only way to
   * ask "was there more?" is a second, wider read — and for the whole-server sweep behind
   * `POST /runs/cancel` that read cannot be ownership-scoped, so its result must never reach a client.
   * Publishing the bound answers the question from the read the caller already did.
   *
   * Optional so an existing third-party driver still satisfies the interface; a caller that needs it
   * must handle its absence. Both bundled drivers provide it.
   */
  readonly maxPageSize?: number;
}

/**
 * A driver-agnostic, JSON-serializable snapshot of every resource row — the unit of bulk
 * transfer for persistence and migration tooling (e.g. `skein dev`'s cross-restart snapshot, and
 * importing an existing LangGraph in-memory dev state). Each entry is an `[id, row]` tuple: the id
 * is the entity's own id, except `items` (keyed by `JSON.stringify([namespace, key])`),
 * `runKwargs` (keyed by `run_id`, since {@link RunKwargs} has no id of its own), and
 * `assistantVersions` (keyed by `JSON.stringify([assistant_id, version])`).
 *
 * A driver MAY expose `restore(snapshot)` to bulk-load one of these verbatim — ids and timestamps
 * preserved — which is what makes an import lossless. It is intentionally not part of
 * {@link SkeinStore}: only migration tooling needs it, and consumers feature-detect it.
 */
export interface SkeinStoreSnapshot {
  assistants: [string, Assistant][];
  assistantVersions: [string, AssistantVersion][];
  threads: [string, Thread][];
  runs: [string, Run][];
  runKwargs: [string, RunKwargs][];
  items: [string, Item][];
  /**
   * Optional so a snapshot written by an older skein still loads — the same tolerance
   * `assistantVersions` gets. This is also what gives `skein dev` cron persistence across restarts
   * for free, since its autosave is one of these.
   *
   * A restore inserts crons *after* threads (a thread cron references one) and skips any cron whose
   * thread is not part of the import, exactly as it does for runs. {@link CronAuth} is deliberately
   * absent: it is not wire state, and a snapshot is a transfer format that gets written to disk.
   */
  crons?: [string, Cron][];
  // Idempotency records are deliberately absent. A dedup window is per-deployment ephemera, not
  // resource state: carrying `in_flight` rows across a `skein dev` reload would make the first retry
  // after a restart 409 against a claim whose request died with the old process, and carrying `done`
  // rows would replay a response naming runs the reloaded store no longer has.
  //
  // Deliveries are absent for the same reason, and one sharper one: a snapshot is a transfer format
  // that gets written to disk, so carrying them would put every run's whole final state into
  // `.skein/` — and restoring one would POST to a URL from a previous `skein dev` session on the
  // next boot, announcing a run the reloaded store may no longer have.
}
