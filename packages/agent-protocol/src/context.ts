// The shared internal state the run-facing services and the background worker must agree on: the
// resolved deps, the per-run cancellation registry (so a cancel can abort a run executing anywhere
// in the same process — inline or on the worker), and the per-thread locks. Built once and threaded
// through, so there is exactly one of each per runtime.

import type { AuthUser } from "@skein-js/core";

import { resolveDeps, type ProtocolDeps, type ResolvedDeps } from "./deps.js";
import { RunControlRegistry } from "./runs/cancellation.js";
import { ThreadLocks } from "./runs/thread-locks.js";

/**
 * What a `multitask_strategy: "rollback"` run must do to the thread *before* it executes: drop the
 * displaced run(s)' checkpoint writes and delete their run rows. Registered at create time and
 * applied once the displaced run has settled (see `startRunExecution`). In-process, like
 * {@link RunControlRegistry} — a single-process seam.
 *
 * `revertToCheckpoint` is `false` when no displaced run wrote checkpoints (all were still pending),
 * so only the rows are deleted; otherwise it carries the base tip to revert to (`baseCheckpointId
 * === undefined` means the displaced run started on a fresh thread, so the revert is a clean wipe).
 */
export interface RollbackPlan {
  revertToCheckpoint: { baseCheckpointId: string | undefined } | false;
  displacedRunIds: string[];
}

export interface ProtocolContext {
  deps: ResolvedDeps;
  control: RunControlRegistry;
  /** Per-thread lock closing the create-guard's check-then-insert race. */
  locks: ThreadLocks;
  /**
   * Per-thread lock serializing run *execution* (distinct from {@link locks}, which only guards
   * creation). Every run executes inside it, so a second run on a busy thread waits its turn — this
   * is what makes `multitask_strategy: "enqueue"` run behind the active run, and what makes an
   * `interrupt`/`rollback` run start only after the displaced run has fully settled.
   */
  executionLocks: ThreadLocks;
  /**
   * runId → the thread's checkpoint tip when that run started executing (`undefined` if the thread
   * had no checkpoints yet). Captured by the engine at `pending -> running`, cleared when the run
   * settles; read to compute a {@link RollbackPlan}. In-process, per {@link control}'s convention.
   */
  runBaseCheckpoints: Map<string, string | undefined>;
  /** New runId → the {@link RollbackPlan} its execution must apply before running. In-process. */
  rollbackPlans: Map<string, RollbackPlan>;
  /**
   * The authenticated caller for the current request, populated by the authorizing handler wrapper
   * so the run service can stamp it onto a run's kwargs. Undefined when no auth engine is
   * configured (the default), matching `langgraph dev` — no principal is injected into the graph.
   */
  authUser?: AuthUser;
  /** The current request's authenticated permission scopes (`AuthContext.scopes`), stamped with {@link authUser}. */
  authScopes?: string[];
}

export function createContext(deps: ProtocolDeps): ProtocolContext {
  return {
    deps: resolveDeps(deps),
    control: new RunControlRegistry(),
    locks: new ThreadLocks(),
    executionLocks: new ThreadLocks(),
    runBaseCheckpoints: new Map(),
    rollbackPlans: new Map(),
  };
}
