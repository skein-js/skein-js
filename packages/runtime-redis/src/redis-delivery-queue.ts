// Redis-backed delivery scheduling on BullMQ — the production path for outbound run-completion
// callbacks.
//
// **Nothing here reimplements retrying.** The whole schedule is BullMQ's: `attempts` bounds how many
// times a callback is tried, its built-in exponential backoff (jitter included) spaces them out,
// delayed jobs hold each one until it is due, and stalled-job recovery re-delivers a job whose
// worker was killed mid-POST.
// That last one is why this needs no lease of its own — BullMQ already has one, and it is better
// tested than anything we would write.
//
// What is *not* BullMQ's is the durability guarantee. The delivery row is written in the same
// transaction as the run's terminal status (see `RunRepo.finalizeWithDelivery`), because a Redis
// `add()` cannot join a Postgres transaction — so the row is the source of truth for the payload, the
// outcome and the replay, and a job is only ever the schedule. A crash between the COMMIT and the
// `add()` therefore loses a *job*, not a notification: the delivery worker's slow sweep finds the row
// and schedules it. That is the same outbox-plus-sweep shape the cron scheduler already uses.

import type {
  DeliveryConsumer,
  DeliveryConsumerOptions,
  DeliveryProcessor,
  DeliveryQueue,
  QueuedDelivery,
  ScheduleDeliveryOptions,
} from "@skein-js/core";
import { Queue, Worker } from "bullmq";

import { settleBullConnection } from "./redis-connection.js";

const JOB_NAME = "delivery";

/**
 * How much of each delay BullMQ randomizes away.
 *
 * Its built-in `exponential` strategy takes this directly, so there is no custom strategy here and no
 * backoff arithmetic of our own — which was the whole point of putting the schedule on BullMQ. The
 * in-memory fallback copies this shape so a retry policy means one thing on both drivers.
 *
 * Jitter is not decoration: without it every callback that failed against one receiver during one
 * outage retries in lockstep forever after, so the receiver comes back up into a synchronized herd of
 * exactly the requests that just overwhelmed it.
 */
const JITTER_FRACTION = 0.2;

export interface RedisDeliveryQueueOptions {
  /** BullMQ queue name; also namespaces the Redis keys. Must not contain `:`. Default `"skein-deliveries"`. */
  queueName?: string;
  /**
   * skein's configured `initial_delay_ms` — the gap between the engine's inline attempt and the
   * first retry. The queue derives its own seed from this; do not pre-adjust it.
   */
  initialDelayMs?: number;
}

const DEFAULT_INITIAL_DELAY_MS = 1_000;

/** BullMQ-backed {@link DeliveryQueue}. Owns its connections; call {@link dispose} to release them. */
export class RedisDeliveryQueue implements DeliveryQueue {
  readonly #queue: Queue<QueuedDelivery>;
  readonly #url: string;
  readonly #queueName: string;
  readonly #initialDelayMs: number;
  readonly #workers = new Set<Worker<QueuedDelivery>>();

  constructor(url: string, options: RedisDeliveryQueueOptions = {}) {
    this.#url = url;
    this.#queueName = options.queueName ?? "skein-deliveries";
    this.#initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.#queue = new Queue<QueuedDelivery>(this.#queueName, { connection: { url } });
  }

  /** A scheduled delivery survives a restart: BullMQ holds it in Redis, not in a process timer. */
  get durable(): boolean {
    return true;
  }

  async schedule(delivery: QueuedDelivery, options: ScheduleDeliveryOptions = {}): Promise<void> {
    const jobId = `${JOB_NAME}-${delivery.delivery_id}`;
    if (options.replace) {
      // Removed rather than left to `add`'s idempotency: an existing delayed job would make the add
      // a no-op, so a replay would quietly wait out the schedule it was asked to skip. Tolerated if
      // it fails — the job may be active or already gone, and the add below is what matters.
      await this.#queue.remove(jobId).catch(() => undefined);
    }
    await this.#queue.add(
      JOB_NAME,
      { delivery_id: delivery.delivery_id },
      {
        ...(options.delayMs !== undefined && options.delayMs > 0 ? { delay: options.delayMs } : {}),
        // Keyed on the delivery id, which makes scheduling **idempotent**: BullMQ refuses a second
        // job with an id already in the queue. That is what lets the recovery sweep re-schedule a
        // delivery it cannot prove was queued, without risking a second callback.
        //
        // Prefixed rather than passed bare, for the reason the run queue documents: BullMQ rejects a
        // custom id that parses as an integer, and skein does not constrain id formats.
        jobId,
        // The attempt budget the queue owns, on top of the engine's inline first attempt.
        ...(options.attempts !== undefined ? { attempts: Math.max(1, options.attempts) } : {}),
        // BullMQ's own exponential backoff, jitter included. This line is the reason there is no
        // retry scheduler in this file: delays, doubling and randomization are all upstream's.
        //
        // Seeded with **twice** the configured initial delay, and that factor is load-bearing.
        // BullMQ computes `2^(attemptsMade - 1) * delay` counting only the attempts *it* made, but
        // the engine already made one inline before this job existed. So its first retry is the
        // schedule's *second* gap, which is `2 × initial`, not `initial`. Seeding it raw halves every
        // delay — turning the documented 12-attempt, ~34-minute horizon into ~17 minutes on Redis
        // while the polling driver still gives 34, which is exactly the "one policy, two meanings"
        // this whole design says must not happen.
        backoff: {
          type: "exponential",
          delay: this.#initialDelayMs * 2,
          jitter: JITTER_FRACTION,
        },
        // Dropped the instant they settle — NOT retained for a window. A retained job keeps holding
        // its `jobId`, and BullMQ answers `add` with the existing job rather than queueing anything,
        // so every later `schedule` for that delivery is a silent no-op: the recovery sweep would
        // report a rescue on every pass while the callback stayed stuck forever. The run queue takes
        // exactly this posture, for exactly this reason.
        //
        // Nothing is lost by dropping them. The delivery row outlives the job and is what the admin
        // list, the replay endpoint and the dead letter all read.
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  consume(process: DeliveryProcessor, options: DeliveryConsumerOptions = {}): DeliveryConsumer {
    const worker = new Worker<QueuedDelivery>(
      this.#queueName,
      async (job) =>
        process({
          deliveryId: job.data.delivery_id,
          // `attemptsMade` counts attempts *finished*, so during the run of attempt n it reads n-1.
          // Asked of the job rather than recomputed from configuration, so the processor and the
          // queue cannot disagree about which attempt is the last — the way they would disagree is a
          // delivery marked dead while BullMQ keeps retrying it, or the reverse.
          isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
        }),
      {
        connection: { url: this.#url },
        concurrency: options.concurrency ?? 5,
      },
    );
    this.#workers.add(worker);
    return {
      close: async (force = false) => {
        this.#workers.delete(worker);
        await worker.close(force);
        if (!force) await settleBullConnection(worker);
      },
    };
  }

  /** Release the queue's own connection. Consumers are closed through their {@link DeliveryConsumer}. */
  async dispose(): Promise<void> {
    await this.#queue.close();
    await settleBullConnection(this.#queue);
  }
}
