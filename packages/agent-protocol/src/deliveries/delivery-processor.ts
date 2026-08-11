// The queue-driven attempt: what a `DeliveryQueue` consumer runs for each job.
//
// The division of labour is the point. **The queue decides when and whether to try again; this
// decides what an attempt means and records what happened.** So on Redis the entire schedule —
// delays, exponential backoff, and re-delivery of a job whose worker was killed — is BullMQ's, and
// none of it is reimplemented here; what stays here is the part BullMQ has no opinion about: which
// row to send, what the body is, and how the outcome is recorded so a replay and an audit still work.

import type { DeliveryAttemptContext, SkeinStore } from "@skein-js/core";

import { deliveryHeaders, type Logger, type WebhookDispatcher } from "../deps.js";

import { queueSweepGraceMs, type WebhookDeliveryConfig } from "./delivery-config.js";
import { toDeliveryBody } from "./delivery-payload.js";
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

  const disallowed = disallowedHost(delivery.url, deps.webhooks?.allowedHosts);
  if (disallowed) {
    deps.logger.warn(`delivery ${delivery.delivery_id}: ${disallowed}`);
    await deliveries.recordAttempt(delivery.delivery_id, { outcome: "dead", error: disallowed });
    return;
  }

  try {
    await deps.webhookDispatcher(
      delivery.url,
      toDeliveryBody(delivery, deps.clock().toISOString()),
      {
        deliveryId: delivery.delivery_id,
        attempt: context.attempt,
        headers: deliveryHeaders(delivery.delivery_id, context.attempt),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (context.isFinalAttempt) {
      deps.logger.error(
        `delivery ${delivery.delivery_id} to ${delivery.url} is dead after ${context.attempt} attempt(s)`,
        error,
      );
      await deliveries.recordAttempt(delivery.delivery_id, {
        outcome: "dead",
        error: message,
        attempt: context.attempt,
      });
      // Deliberately NOT rethrown. The delivery is settled; asking the queue to retry it would
      // contradict the row we just wrote, and on BullMQ would leave a job in the failed set whose
      // dead letter already lives somewhere an operator can replay it from.
      return;
    }
    deps.logger.warn(
      `delivery ${delivery.delivery_id} to ${delivery.url} failed (attempt ${context.attempt}); retrying`,
      error,
    );
    // The row records *that* it failed and why. When it is due again is the queue's call, so the row's
    // `next_attempt_at` is refreshed to a lease rather than to a schedule — it is what a recovery
    // sweep reads when a job goes missing, not what decides the retry.
    await deliveries.recordAttempt(delivery.delivery_id, {
      outcome: "retrying",
      nextAttemptAt: new Date(
        deps.clock().getTime() + queueSweepGraceMs(deps.webhooks?.retries),
      ).toISOString(),
      error: message,
      attempt: context.attempt,
    });
    throw error;
  }

  await deliveries.recordAttempt(delivery.delivery_id, { outcome: "delivered" });
}
