// One delivery attempt: send it, then record what happened.
//
// Used by **both** the engine's inline first attempt and the delivery worker's retries, so there is
// exactly one place that decides what an attempt is, when a failure is terminal, and when the next
// one is due. Two copies of that would drift, and the way they would drift is a delivery that the
// engine considers dead and the worker keeps retrying.

import type { Delivery, DeliveryAttemptResult, DeliveryQueue, SkeinStore } from "@skein-js/core";

import { deliveryHeaders, type Logger, type WebhookDispatcher } from "../deps.js";

import { isFinalAttempt, nextAttemptDelayMs } from "./backoff.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  queueSweepGraceMs,
  type WebhookDeliveryConfig,
} from "./delivery-config.js";
import { toDeliveryBody } from "./delivery-payload.js";
import { disallowedHost } from "./delivery-target.js";

export interface AttemptDeliveryDeps {
  store: Pick<SkeinStore, "deliveries">;
  webhookDispatcher: WebhookDispatcher;
  logger: Logger;
  clock: () => Date;
  webhooks?: WebhookDeliveryConfig;
  /**
   * Where the retry goes when this attempt fails. Present in a Redis deployment, absent in
   * development — see {@link DeliveryQueue}.
   *
   * With a queue, **every decision about when to try again belongs to it**: this records what
   * happened and hands the delivery over, and the row's `next_attempt_at` becomes a lost-job marker
   * for the recovery sweep rather than a schedule. Without one, the row's `next_attempt_at` *is* the
   * schedule and the polling worker reads it.
   */
  deliveryQueue?: DeliveryQueue;
}

/**
 * Attempt `delivery` once and record the outcome. Resolves to the settled row, or `null` if the
 * delivery vanished under us.
 *
 * **Never rejects.** Its two callers both need that: the engine's `finally` must not turn a failed
 * callback into a failed run, and the worker's tick must not lose the rest of its batch to one bad
 * receiver. A failure becomes a recorded attempt, which is the whole point — today's dispatcher
 * swallows the error into a log line and nothing remembers it happened.
 */
export async function attemptDelivery(
  deps: AttemptDeliveryDeps,
  delivery: Delivery,
): Promise<Delivery | null> {
  const deliveries = deps.store.deliveries;
  if (!deliveries) return null;

  const disallowed = disallowedHost(delivery.url, deps.webhooks?.allowedHosts);
  if (disallowed) {
    // Dead on the spot rather than retried: no number of attempts makes a disallowed host allowed,
    // and recording it is what keeps this visible in the delivery list instead of being a callback
    // that simply never arrives.
    deps.logger.warn(`delivery ${delivery.delivery_id}: ${disallowed}`);
    return deliveries.recordAttempt(delivery.delivery_id, { outcome: "dead", error: disallowed });
  }

  const sentAt = deps.clock().toISOString();
  // The POST is caught on its own, NOT in a try that also wraps the record below. Wrapping both
  // would misread a database blip *after* a successful POST as a failed delivery — scheduling a
  // retry, and so a second POST, for a callback the receiver already has.
  let dispatchFailure: { cause: unknown } | undefined;
  try {
    await deps.webhookDispatcher(delivery.url, toDeliveryBody(delivery, sentAt), {
      deliveryId: delivery.delivery_id,
      attempt: delivery.attempt,
      headers: deliveryHeaders(delivery.delivery_id, delivery.attempt),
    });
  } catch (cause) {
    dispatchFailure = { cause };
  }

  const result: DeliveryAttemptResult = dispatchFailure
    ? failureResult(deps, delivery, dispatchFailure.cause)
    : { outcome: "delivered" };

  if (result.outcome === "dead") {
    // Logged at error, unlike a retry: this is the last word on a callback nobody received, and it
    // is the line an operator greps for before reaching for the replay endpoint.
    deps.logger.error(
      `delivery ${delivery.delivery_id} to ${delivery.url} is dead after ${delivery.attempt} attempt(s)`,
      dispatchFailure?.cause,
    );
  } else if (dispatchFailure) {
    deps.logger.warn(
      `delivery ${delivery.delivery_id} to ${delivery.url} failed (attempt ${delivery.attempt}); retrying`,
      dispatchFailure.cause,
    );
  }

  try {
    const settled = await deliveries.recordAttempt(delivery.delivery_id, result);
    if (result.outcome === "retrying" && deps.deliveryQueue) {
      // Handed over rather than left for a poller. `schedule` is idempotent on the delivery id, so a
      // recovery sweep that cannot prove this happened may safely repeat it.
      await deps.deliveryQueue.schedule(
        { delivery_id: delivery.delivery_id },
        {
          // The delay for *this* retry is ours, because the queue's own backoff only spaces attempts
          // it made itself and this one was made inline. Every subsequent delay is the queue's.
          delayMs: nextAttemptDelayMs(delivery.attempt, deps.webhooks?.retries),
          // What is left of the budget after the inline attempt and this one.
          attempts: Math.max(
            1,
            (deps.webhooks?.retries?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) - delivery.attempt,
          ),
        },
      );
    }
    return settled;
  } catch (error) {
    // Swallowed, so this function keeps its promise never to reject — its two callers both need
    // that. The cost of losing the write is bounded and self-healing: the row keeps its lease, and
    // the next `claimDue` after the lease expires simply attempts it again. That is one duplicate
    // POST, which at-least-once already permits, against a rejection here propagating into the
    // engine's `finally` or killing the rest of the worker's batch.
    deps.logger.error(
      `delivery ${delivery.delivery_id}: could not record a ${result.outcome} attempt; ` +
        `it stays leased and will be retried`,
      error,
    );
    return null;
  }
}

/** Classify a failed attempt: out of attempts is `dead`, anything else is due again later. */
function failureResult(
  deps: AttemptDeliveryDeps,
  delivery: Delivery,
  error: unknown,
): DeliveryAttemptResult {
  const message = error instanceof Error ? error.message : String(error);
  if (isFinalAttempt(delivery.attempt, deps.webhooks?.retries)) {
    return { outcome: "dead", error: message };
  }
  // With a queue, `next_attempt_at` is not a schedule — the queue holds that — so it is pushed far
  // enough out that the recovery sweep only ever sees a delivery whose job is genuinely lost.
  const dueInMs = deps.deliveryQueue
    ? queueSweepGraceMs(deps.webhooks?.retries)
    : nextAttemptDelayMs(delivery.attempt, deps.webhooks?.retries);
  return {
    outcome: "retrying",
    nextAttemptAt: new Date(deps.clock().getTime() + dueInMs).toISOString(),
    error: message,
  };
}
