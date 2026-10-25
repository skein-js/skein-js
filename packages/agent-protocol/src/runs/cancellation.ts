// Per-run cancellation, kept in one small stateful place. Each executing run registers an
// `AbortController`; a cancel or timeout aborts its signal (which LangGraph's `stream`/`invoke`
// honor) and records *why*, so the engine's catch can distinguish a cancel from a timeout from a
// genuine graph error.
//
// The registry itself is per-process — it holds `AbortController`s, which cannot leave one. What crosses
// instances is the *request*: when a `RunAbortChannel` is configured, explicit aborts are broadcast
// so they reach every executor or recovery waiter for that run. See `RunAbortChannel`.

import type { RunAbortChannel } from "@skein-js/core";

import type { Logger } from "../deps.js";

/**
 * Why a run was aborted. Absent (`null`) means the run failed on its own.
 * - `cancel` — explicit `POST /runs/{id}/cancel`; the run settles `cancelled`.
 * - `timeout` — the run exceeded `runTimeoutMs`; it settles `timeout`.
 * - `interrupt` — displaced by a `multitask_strategy: "interrupt"` run; it settles `interrupted`,
 *   keeping its checkpoint writes.
 * - `rollback` — displaced by a `multitask_strategy: "rollback"` run; it settles terminally and the
 *   displacing run then discards its checkpoint writes (see the run service).
 */
export type AbortReason = "cancel" | "timeout" | "interrupt" | "rollback";

/** Handle handed to the engine for a run: the signal to thread into the graph, and the reason box. */
export interface RunControl {
  signal: AbortSignal;
  /** Mutable so the aborter can record the reason the engine reads after the abort fires. */
  reason: { current: AbortReason | null };
  /** Abort *this* run (e.g. the engine's own timeout); records the reason like an external cancel. */
  abort(reason: AbortReason): void;
}

interface ControlEntry {
  registrations: number;
  controller: AbortController;
  reason: { current: AbortReason | null };
  abort(reason: AbortReason): void;
}

export class RunControlRegistry {
  readonly #entries = new Map<string, ControlEntry>();
  /**
   * Where explicit abort requests go. A local registration may only be a recovery waiter, so it
   * cannot prove this process holds execution rights. Set once by the runtime when a
   * `RunAbortChannel` is configured; absent means single-process, which is the default and was the only
   * behaviour before.
   */
  #abortChannel?: RunAbortChannel;
  #logger?: Logger;

  /**
   * Broadcast explicit aborts onto `channel`, so they reach the instance that is executing the
   * run. Called by the runtime during assembly, before any run starts.
   */
  useAbortChannel(channel: RunAbortChannel, logger?: Logger): void {
    this.#abortChannel = channel;
    this.#logger = logger;
  }

  /** Start tracking a run and return its abort signal + reason box. */
  register(runId: string): RunControl {
    const existing = this.#entries.get(runId);
    if (existing) {
      existing.registrations++;
      return { signal: existing.controller.signal, reason: existing.reason, abort: existing.abort };
    }
    const controller = new AbortController();
    const reason: { current: AbortReason | null } = { current: null };
    const abort = (next: AbortReason): void => {
      // First reason wins; aborting twice is a no-op on the already-aborted controller.
      if (reason.current === null) reason.current = next;
      controller.abort();
    };
    this.#entries.set(runId, { registrations: 1, controller, reason, abort });
    return { signal: controller.signal, reason, abort };
  }

  /**
   * Abort a tracked run with a reason. Returns whether it was aborted **here** — false means this
   * process has no registration for it.
   *
   * Always publishes on the configured abort channel: a local registration may be waiting behind a
   * remote executor. This includes shutdown's grace-expiry aborts, which must reach that owner too. Published
   * fire-and-forget — the caller has already marked the run terminal in the store, so a publish failure
   * costs promptness, not correctness, and must not fail the cancel that triggered it.
   */
  abort(runId: string, reason: AbortReason): boolean {
    const entry = this.#entries.get(runId);
    entry?.abort(reason);
    this.#forwardAbort(runId, reason);
    return entry !== undefined;
  }

  /**
   * Apply an abort request that arrived *from* the channel. Never re-publishes — that would bounce the
   * message back and forth between instances forever, since neither can tell a forwarded request from a
   * fresh one.
   */
  applyRemoteAbort(runId: string, reason: AbortReason): void {
    this.#entries.get(runId)?.abort(reason);
  }

  #forwardAbort(runId: string, reason: AbortReason): void {
    const channel = this.#abortChannel;
    if (!channel) return;
    void channel.requestAbort({ run_id: runId, reason }).catch((error: unknown) => {
      this.#logger?.warn(`run ${runId}: could not broadcast the ${reason} request to peers`, error);
    });
  }

  /** Stop tracking a run once it has settled. */
  clear(runId: string): void {
    const entry = this.#entries.get(runId);
    if (entry && --entry.registrations === 0) this.#entries.delete(runId);
  }

  /** Whether a run has an executing or waiting registration. */
  isTracking(runId: string): boolean {
    return this.#entries.has(runId);
  }
}
