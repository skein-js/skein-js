// Telling a channel that a run is still working.
//
// This exists because the acknowledgement is early by necessity — Slack gives you three seconds
// before it retries and shows the user an error — so progress cannot ride the response. Without it a
// customer stares at a dead chat window for however long the graph takes.

import type { Channel, ReplyTarget, RunSignal } from "../channel/channel.js";

/** A run's frames, as the pipeline consumes them. */
export interface RunFrames {
  subscribe(runId: string): AsyncIterable<{ seq: number; event: string; data?: unknown }>;
}

export interface FanOutOptions {
  channel: Channel;
  runId: string;
  target: ReplyTarget;
  frames: RunFrames;
  logger: { warn(message: string, error?: unknown): void };
  /** Stops the keepalive from running forever if a run never closes. */
  maxMs?: number;
}

const DEFAULT_MAX_MS = 5 * 60_000;

/**
 * Follow a run and hand its progress to the channel, until it settles.
 *
 * **Best-effort, and deliberately not awaited by the caller.** Every guarantee here is the opposite of
 * `deliver`'s: at most once, never retried, dropped on any error. Retrying a "typing" indicator four
 * minutes late is nonsense, and a provider being slow to accept one must never hold up the run or the
 * acknowledgement the provider is waiting on.
 *
 * The first signal fires immediately rather than on the first frame: a graph whose first node takes
 * ten seconds would otherwise show nothing for ten seconds, which is exactly the window this exists to
 * cover.
 */
export function fanOutRunSignals(options: FanOutOptions): void {
  const { channel, runId, target, frames, logger } = options;
  const wants = new Set(channel.signals?.kinds ?? []);
  if (!channel.onSignal || wants.size === 0) return;

  void (async () => {
    const emit = async (signal: RunSignal): Promise<void> => {
      try {
        await channel.onSignal?.(signal, target);
      } catch (error) {
        // Swallowed on purpose. A failed indicator is not a failed run, and surfacing it would turn a
        // cosmetic problem into a delivered error.
        logger.warn(
          `channel "${channel.name}": ${signal.kind} signal failed for run ${runId}`,
          error,
        );
      }
    };

    let settled = false;
    const started = Date.now();

    // Most providers expire an indicator within seconds, so it has to be re-sent while the run works.
    // A timer rather than a frame-driven refresh, because a graph can be busy without emitting
    // anything — a single long model call produces no frames at all.
    // Armed whenever a cadence is set, and the signal it emits follows what the channel subscribed
    // to. Requiring `kinds: ["keepalive"]` looked tidier and was wrong: every documented example pairs
    // `keepaliveMs` with `kinds: ["progress"]`, because most providers refresh an indicator by
    // re-sending the *same* call rather than a distinct one — so the timer never armed and the
    // indicator expired mid-run, silently.
    const keepaliveMs = channel.signals?.keepaliveMs;
    const keepaliveKind = wants.has("keepalive") ? "keepalive" : "progress";
    const keepalive = keepaliveMs
      ? setInterval(() => {
          if (settled || Date.now() - started > (options.maxMs ?? DEFAULT_MAX_MS)) {
            // Past the cap, or the run is done: stop the timer here rather than leaving it ticking
            // until the frame stream ends, which for a run that never closes is forever.
            clearInterval(keepalive);
            return;
          }
          void emit({ kind: keepaliveKind, runId } as RunSignal);
        }, keepaliveMs)
      : undefined;
    // Never hold the process open for a cosmetic timer.
    keepalive?.unref?.();

    try {
      if (wants.has("progress")) await emit({ kind: "progress", runId });
      for await (const frame of frames.subscribe(runId)) {
        if (Date.now() - started > (options.maxMs ?? DEFAULT_MAX_MS)) break;
        if (!wants.has("progress")) continue;
        // The frame's *arrival* is the signal; its contents are the graph's business. A channel that
        // wants more gets `node` and `custom`, but an indicator needs neither.
        await emit({ kind: "progress", runId, ...(frame.event ? { node: frame.event } : {}) });
      }
    } catch (error) {
      logger.warn(`channel "${channel.name}": stopped following run ${runId}`, error);
    } finally {
      settled = true;
      if (keepalive) clearInterval(keepalive);
    }
  })();
}
