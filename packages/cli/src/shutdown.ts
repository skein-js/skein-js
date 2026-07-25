// Graceful shutdown for the in-process commands (`skein dev` and `skein start`). Both close their
// server + runtime on SIGINT/SIGTERM and force exit if that stalls, so the shape lives here once.
//
// The force-exit timer must outlast the worker's drain window, not match it. `worker.stop()` races a
// graceful drain against `shutdownGraceMs`, and only *then* aborts whatever is still running so those
// runs settle to a terminal status. Firing the force-exit at the same instant kills the process
// during that abort, leaving runs stuck `running` in the store — which the next instance has no way
// to distinguish from a run that is genuinely still executing.

import { DEFAULT_SHUTDOWN_GRACE_MS } from "@skein-js/server-kit";

/**
 * Extra time the force-exit timer allows on top of the worker's drain window: enough for the abort
 * step to stamp each straggler terminal and for the pools to close, but short enough that
 * `DEFAULT_SHUTDOWN_GRACE_MS` + this stays inside the tightest common SIGTERM→SIGKILL window (~10s on
 * Cloud Run and `docker stop`).
 */
export const FORCE_EXIT_BUFFER_MS = 3000;

/**
 * How long to wait before forcing exit, given the worker's drain window. Strictly greater than
 * `graceMs` — that inequality is the whole point (see the note above).
 */
export function forceExitDelayMs(graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS): number {
  return graceMs + FORCE_EXIT_BUFFER_MS;
}

export interface ShutdownHandlerOptions {
  /** How long to wait for `close()` before exiting anyway — use {@link forceExitDelayMs}. */
  forceExitMs: number;
  /** Release everything: the HTTP server, the run worker, the drivers. Never expected to reject. */
  close: () => Promise<unknown>;
  /** Runs before the force-exit timer is armed — for state that must be flushed synchronously. */
  onShutdownStart?: () => void;
  /** Injected for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Build the SIGINT/SIGTERM handler. Idempotent: a second signal (an impatient Ctrl-C, or a platform
 * that re-sends) is ignored rather than starting a second teardown.
 */
export function createShutdownHandler(options: ShutdownHandlerOptions): () => void {
  const { forceExitMs, close, onShutdownStart, exit = (code) => process.exit(code) } = options;
  let shuttingDown = false;
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    onShutdownStart?.();
    // `unref` so a fast, clean shutdown isn't held open by this timer.
    const forceExit = setTimeout(() => exit(0), forceExitMs);
    forceExit.unref();
    void close().then(() => exit(0));
  };
}
