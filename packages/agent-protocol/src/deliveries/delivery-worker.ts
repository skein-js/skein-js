// The delivery loop. It has two jobs, and which one it is doing depends on whether a `DeliveryQueue`
// is wired.
//
// **With a queue — the production path — this is a recovery sweep, not a retry loop.** The queue owns
// the schedule (on Redis that is BullMQ: delayed jobs, exponential backoff with jitter, and
// re-delivery of a job whose worker was killed), so a delivery that still looks due here means its
// *job* was lost — which happens in exactly one window, between the outbox COMMIT and the enqueue,
// because a Redis `add()` cannot join a Postgres transaction. This sweep hands those rows back to the
// queue. It ticks rarely, because that is a crash-only event. Same outbox-plus-sweep shape the cron
// scheduler uses, and for the same reason.
//
// **Without one — development — it is the retry loop itself**, polling the outbox for rows whose
// `next_attempt_at` has arrived and POSTing them. Correct, process-local, and lost on restart. That
// is fine for `skein dev`; point a local Redis at it (`skein dev --queue redis`) to exercise what
// production actually does.
//
// The retention sweep rides along on a slower cadence rather than living in a second loop: it is one
// indexed DELETE, and one loop is one thing to start, one thing to stop, and one thing to get wrong.

import type { DeliveryQueue, SkeinStore } from "@skein-js/core";

import type { Logger, WebhookDispatcher } from "../deps.js";

import { attemptDelivery } from "./attempt-delivery.js";
import {
  DEFAULT_DELIVERY_BATCH_SIZE,
  DEFAULT_DELIVERY_POLL_INTERVAL_MS,
  DEFAULT_SWEEP_POLL_INTERVAL_MS,
  DELIVERY_LEASE_MS,
  remainingQueueAttempts,
  type WebhookDeliveryConfig,
} from "./delivery-config.js";

/**
 * How often the retention sweep runs, regardless of the poll cadence.
 *
 * Measured in elapsed time rather than in ticks, because the poll cadence is not fixed: with a queue
 * this loop ticks every five minutes rather than every five seconds, so a tick *count* would stretch
 * the same "every ten minutes" into every ten hours.
 */
const SWEEP_INTERVAL_MS = 600_000;

export interface DeliveryWorkerDeps {
  store: Pick<SkeinStore, "deliveries">;
  webhookDispatcher: WebhookDispatcher;
  logger: Logger;
  /** Injected so tests can drive time; defaults to the wall clock, like every sweeper here. */
  clock?: () => Date;
  webhooks?: WebhookDeliveryConfig;
  /**
   * When present, this loop stops being the retry mechanism and becomes a **recovery sweep**: the
   * queue owns the schedule, so a row that still looks due is evidence of a job lost to a crash
   * between the outbox COMMIT and the enqueue. It ticks rarely and hands what it finds back to the
   * queue rather than POSTing it.
   */
  deliveryQueue?: DeliveryQueue;
}

export interface DeliveryWorkerOptions {
  /** How often to look for due deliveries, in ms. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Deliveries claimed per tick. Defaults to 20. */
  batchSize?: number;
}

/** What one tick did, for tests and probes. */
export interface DeliveryTickSummary {
  claimed: number;
  delivered: number;
  failed: number;
  swept: number;
}

export interface DeliveryWorker {
  /** Claim and attempt one batch. Exposed so tests drive the loop instead of waiting on a timer. */
  tickOnce(): Promise<DeliveryTickSummary>;
  start(): void;
  stop(): Promise<void>;
}

export function createDeliveryWorker(
  deps: DeliveryWorkerDeps,
  options: DeliveryWorkerOptions = {},
): DeliveryWorker {
  const clock = deps.clock ?? ((): Date => new Date());
  const everyMs =
    options.pollIntervalMs ??
    (deps.deliveryQueue ? DEFAULT_SWEEP_POLL_INTERVAL_MS : DEFAULT_DELIVERY_POLL_INTERVAL_MS);
  const batchSize = options.batchSize ?? DEFAULT_DELIVERY_BATCH_SIZE;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let lastSweptAtMs: number | undefined;

  const tickOnce = async (): Promise<DeliveryTickSummary> => {
    const deliveries = deps.store.deliveries;
    const summary: DeliveryTickSummary = { claimed: 0, delivered: 0, failed: 0, swept: 0 };
    if (!deliveries) return summary;

    const now = clock();
    const claimed = await deliveries.claimDue({
      now: now.toISOString(),
      // The claim moves each row's `next_attempt_at` to the lease, so a peer only takes it over if
      // this process dies mid-POST — see `Delivery.next_attempt_at`.
      leaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString(),
      limit: batchSize,
    });
    summary.claimed = claimed.length;

    if (deps.deliveryQueue) {
      // Recovery, not delivery: hand each row back and let the queue schedule it. `schedule` is
      // idempotent on the delivery id, so re-scheduling one that is somehow still queued costs
      // nothing — which is what makes a blind sweep safe.
      for (const delivery of claimed) {
        deps.logger.warn(
          `delivery ${delivery.delivery_id}: no queued job found; re-scheduling it (attempt ${delivery.attempt})`,
        );
        await deps.deliveryQueue.schedule(
          { delivery_id: delivery.delivery_id },
          // The remaining budget, NOT the default. Omitting it hands BullMQ its own default of one
          // attempt, so a recovered delivery would go dead on its next failure instead of finishing
          // the schedule its configuration promised — and it would look like the policy was ignored.
          { attempts: remainingQueueAttempts(delivery.attempt, deps.webhooks?.retries) },
        );
      }
    } else {
      // Sequential rather than concurrent: a backlog is usually a backlog against *one* receiver that
      // is already struggling, and firing a batch at it in parallel is how a retry storm becomes the
      // outage. The batch is bounded, and every instance drains its own share.
      for (const delivery of claimed) {
        const settled = await attemptDelivery(
          {
            store: { deliveries },
            webhookDispatcher: deps.webhookDispatcher,
            logger: deps.logger,
            clock,
            ...(deps.webhooks ? { webhooks: deps.webhooks } : {}),
          },
          delivery,
        );
        if (settled?.status === "delivered") summary.delivered += 1;
        else summary.failed += 1;
      }
    }

    // Outside the branch above, deliberately. Retention is not a property of *how* a delivery was
    // attempted, and skipping it on the queue path would make `retain_hours` a no-op in exactly the
    // deployments that have the most rows — settled deliveries, dead ones still holding their whole
    // payload, accumulating forever.
    const nowMs = clock().getTime();
    if (lastSweptAtMs === undefined || nowMs - lastSweptAtMs >= SWEEP_INTERVAL_MS) {
      lastSweptAtMs = nowMs;
      // Plain `now`. A delivery's `expires_at` was already set to its creation time plus the
      // configured retention, so subtracting the retention again here would apply it twice and keep
      // every settled row for double what `retain_hours` says.
      summary.swept = await deliveries.sweepExpired(new Date(nowMs).toISOString());
      if (summary.swept > 0) {
        deps.logger.info(`delivery sweep removed ${summary.swept} settled delivery/deliveries.`);
      }
    }
    return summary;
  };

  /**
   * The loop. Its single most important property, like every other background loop here: it always
   * schedules the next tick. The reschedule is in a `finally` and the catch never rethrows, so no
   * failure mode — a receiver that hangs, a database blip — silently ends delivery for the life of
   * the process.
   */
  const loop = async (): Promise<void> => {
    try {
      await tickOnce();
    } catch (error) {
      deps.logger.error("delivery tick failed; the worker continues.", error);
    } finally {
      if (running) {
        timer = setTimeout(runLoop, everyMs);
        timer.unref?.();
      }
    }
  };

  const runLoop = (): void => {
    inFlight = loop();
  };

  return {
    tickOnce,

    start() {
      if (running) return;
      running = true;
      timer = setTimeout(runLoop, everyMs);
      timer.unref?.();
    },

    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      // Wait out a tick already in flight, so `stop()` resolving means nothing is still POSTing.
      // It cannot reject — `loop` swallows its own failures — so this needs no catch.
      await inFlight;
      inFlight = undefined;
    },
  };
}
