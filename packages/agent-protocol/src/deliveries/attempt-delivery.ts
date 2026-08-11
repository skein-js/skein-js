// One delivery attempt: send it, then record what happened.
//
// Used by **both** the engine's inline first attempt and the delivery worker's retries, so there is
// exactly one place that decides what an attempt is, when a failure is terminal, and when the next
// one is due. Two copies of that would drift, and the way they would drift is a delivery that the
// engine considers dead and the worker keeps retrying.

import type { Delivery, DeliveryAttemptResult, DeliveryQueue, SkeinStore } from "@skein-js/core";

import type { Logger, WebhookDispatcher } from "../deps.js";

import { isFinalAttempt, nextAttemptDelayMs } from "./backoff.js";
import {
  QUEUE_SWEEP_MARGIN_MS,
  remainingQueueAttempts,
  type WebhookDeliveryConfig,
} from "./delivery-config.js";
import { toDeliveryRequest } from "./delivery-request.js";
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

  /**
   * Record an outcome without ever rejecting.
   *
   * Every write in this function goes through here. An unguarded one would break the contract in the
   * worst possible place: the engine awaits this inside a `finally`, so a rejection escapes into
   * `startRunExecution` and skips the cleanup that follows it — leaving a run registered in the
   * control registry and a stateless run's thread undeleted, and turning a successful run into a 500.
   */
  const record = async (result: DeliveryAttemptResult): Promise<Delivery | null> => {
    try {
      return await deliveries.recordAttempt(delivery.delivery_id, result);
    } catch (error) {
      // Bounded and self-healing: the row keeps its lease, so the next claim attempts it again. That
      // is one duplicate POST, which at-least-once already permits and the delivery id absorbs.
      deps.logger.error(
        `delivery ${delivery.delivery_id}: could not record a ${result.outcome} attempt; ` +
          `it stays leased and will be retried`,
        error,
      );
      return null;
    }
  };

  const disallowed = disallowedHost(delivery.url, deps.webhooks?.allowedHosts);
  if (disallowed) {
    // Dead on the spot rather than retried: no number of attempts makes a disallowed host allowed,
    // and recording it is what keeps this visible in the delivery list instead of being a callback
    // that simply never arrives.
    deps.logger.warn(`delivery ${delivery.delivery_id}: ${disallowed}`);
    return record({ outcome: "dead", error: disallowed });
  }

  const sentAt = deps.clock();
  const request = toDeliveryRequest({
    delivery,
    attempt: delivery.attempt,
    sentAt,
    ...(deps.webhooks?.secrets ? { secrets: deps.webhooks.secrets } : {}),
  });
  // The POST is caught on its own, NOT in a try that also wraps the record below. Wrapping both
  // would misread a database blip *after* a successful POST as a failed delivery — scheduling a
  // retry, and so a second POST, for a callback the receiver already has.
  let dispatchFailure: { cause: unknown } | undefined;
  try {
    await deps.webhookDispatcher(delivery.url, request.payload, request.attempt);
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

  const settled = await record(result);
  if (result.outcome !== "retrying" || !deps.deliveryQueue) return settled;

  // Handed over rather than left for a poller. `schedule` is idempotent on the delivery id, so a
  // recovery sweep that cannot prove this happened may safely repeat it.
  try {
    await deps.deliveryQueue.schedule(
      { delivery_id: delivery.delivery_id },
      {
        // The delay for *this* retry is ours, because the queue's own backoff only spaces attempts
        // it made itself and this one was made inline. Every subsequent delay is the queue's.
        delayMs: nextAttemptDelayMs(delivery.attempt, deps.webhooks?.retries),
        attempts: remainingQueueAttempts(delivery.attempt, deps.webhooks?.retries),
      },
    );
    return settled;
  } catch (error) {
    // The hand-off failed, so nothing owns this delivery's schedule — and the row was written on the
    // assumption that something did, with `next_attempt_at` hours out where the sweep would not look
    // for it until then. Pull it back onto the polling schedule so the sweep picks it up on its next
    // pass. Without this, a momentary Redis blip turns a one-second retry into a multi-hour one.
    deps.logger.error(
      `delivery ${delivery.delivery_id}: could not hand the retry to the delivery queue; ` +
        `falling back to the polling schedule`,
      error,
    );
    return record({
      ...result,
      nextAttemptAt: new Date(
        deps.clock().getTime() + nextAttemptDelayMs(delivery.attempt, deps.webhooks?.retries),
      ).toISOString(),
    });
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
  // With a queue, `next_attempt_at` is not the schedule — the queue holds that — but it is still when
  // the recovery sweep starts looking, so it stays close to the real next attempt plus a margin. Long
  // enough that the sweep does not race an ordinary retry; short enough that a job lost to a crash is
  // found on the next pass rather than hours later.
  const delayMs = nextAttemptDelayMs(delivery.attempt, deps.webhooks?.retries);
  const dueInMs = deps.deliveryQueue ? delayMs + QUEUE_SWEEP_MARGIN_MS : delayMs;
  return {
    outcome: "retrying",
    nextAttemptAt: new Date(deps.clock().getTime() + dueInMs).toISOString(),
    error: message,
  };
}
