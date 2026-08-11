// The queue-driven attempt: what a `DeliveryQueue` consumer runs for each job.
//
// The division of labour is the point. **The queue decides when and whether to try again; this
// decides what an attempt means and records what happened.** So on Redis the entire schedule —
// delays, exponential backoff, and re-delivery of a job whose worker was killed — is BullMQ's, and
// none of it is reimplemented here; what stays here is the part BullMQ has no opinion about: which
// row to send, what the body is, and how the outcome is recorded so a replay and an audit still work.

import type { DeliveryAttemptContext, SkeinStore } from "@skein-js/core";

import type { Logger, WebhookDispatcher } from "../deps.js";

import { nextAttemptDelayMs } from "./backoff.js";
import { QUEUE_SWEEP_MARGIN_MS, type WebhookDeliveryConfig } from "./delivery-config.js";
import { toDeliveryRequest } from "./delivery-request.js";
import { disallowedHost } from "./delivery-target.js";

export interface DeliveryProcessorDeps {
  store: Pick<SkeinStore, "deliveries">;
  webhookDispatcher: WebhookDispatcher;
  logger: Logger;
  clock: () => Date;
  webhooks?: WebhookDeliveryConfig;
}

/**
 * Attempt the delivery named by `context`, recording the outcome.
 *
 * **Throws when the attempt failed and another is due** — that is how a queue is told to schedule the
 * next one, and it is why this is a separate function from `attemptDelivery` rather than a flag on
 * it: the engine's inline attempt must never throw (a failed callback is not a failed run), and this
 * one must, or BullMQ would mark a job complete that nobody has delivered.
 *
 * Returns normally when there is nothing left to do: delivered, out of attempts, or already settled
 * by whoever else picked it up.
 */
export async function processDelivery(
  deps: DeliveryProcessorDeps,
  context: DeliveryAttemptContext,
): Promise<void> {
  const deliveries = deps.store.deliveries;
  if (!deliveries) return;

  const delivery = await deliveries.get(context.deliveryId);
  // Gone, or already settled by a peer that beat us to it — either way there is nothing to send, and
  // throwing would ask the queue to keep retrying a delivery that is finished.
  if (!delivery) return;
  if (delivery.status === "delivered" || delivery.status === "dead") return;

  // From the row, not from the job: the row is the running total, and it is the only count that
  // survives the queue re-creating a job for this delivery. See `DeliveryAttemptContext`.
  const attempt = delivery.attempt + 1;

  const disallowed = disallowedHost(delivery.url, deps.webhooks?.allowedHosts);
  if (disallowed) {
    deps.logger.warn(`delivery ${delivery.delivery_id}: ${disallowed}`);
    await deliveries.recordAttempt(delivery.delivery_id, { outcome: "dead", error: disallowed });
    return;
  }

  try {
    const request = toDeliveryRequest({
      delivery,
      attempt,
      sentAt: deps.clock(),
      ...(deps.webhooks?.secrets ? { secrets: deps.webhooks.secrets } : {}),
    });
    await deps.webhookDispatcher(delivery.url, request.payload, request.attempt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (context.isFinalAttempt) {
      deps.logger.error(
        `delivery ${delivery.delivery_id} to ${delivery.url} is dead after ${attempt} attempt(s)`,
        error,
      );
      await deliveries.recordAttempt(delivery.delivery_id, {
        outcome: "dead",
        error: message,
        attempt,
      });
      // Deliberately NOT rethrown. The delivery is settled; asking the queue to retry it would
      // contradict the row we just wrote, and on BullMQ would leave a job in the failed set whose
      // dead letter already lives somewhere an operator can replay it from.
      return;
    }
    deps.logger.warn(
      `delivery ${delivery.delivery_id} to ${delivery.url} failed (attempt ${attempt}); retrying`,
      error,
    );
    // The row records *that* it failed and why. When it is due again is the queue's call, so this is
    // an estimate of the queue's own next attempt plus a margin — what the recovery sweep reads when
    // a job goes missing, not what decides the retry. The estimate is good because our backoff was
    // deliberately shaped to match BullMQ's.
    await deliveries.recordAttempt(delivery.delivery_id, {
      outcome: "retrying",
      nextAttemptAt: new Date(
        deps.clock().getTime() +
          nextAttemptDelayMs(attempt, deps.webhooks?.retries) +
          QUEUE_SWEEP_MARGIN_MS,
      ).toISOString(),
      error: message,
      attempt,
    });
    throw error;
  }

  await deliveries.recordAttempt(delivery.delivery_id, { outcome: "delivered" });
}
