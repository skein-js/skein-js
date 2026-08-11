// Where an outbound run-completion callback waits between attempts.
//
// Separate from {@link RunQueue} rather than a widening of it, because the two carry different work
// with different retry semantics: a run is executed **once** and its failure is recorded on its own
// row (`attempts: 1`, `removeOnFail: true` in the Redis driver), while a delivery is retried on a
// schedule and its failure is a reason to try again. Folding them together would mean one set of job
// options serving both, and the run queue's options are already load-bearing for the cron sweep.
//
// **The queue owns the retry schedule; the store owns the truth.** The delivery row is written in the
// same transaction as the run's terminal status and holds the payload, the attempt count and the
// outcome — so a lost job is recoverable and a replay has something to resend. What the queue decides
// is only *when* the next attempt happens, and whether there is one. That split is what lets the
// Redis driver hand the whole schedule to BullMQ (delayed jobs, exponential backoff, stalled-job
// recovery) without the durability guarantee depending on Redis.

/** A delivery handed to the queue. Identity only: the payload is read from the store at send time. */
export interface QueuedDelivery {
  delivery_id: string;
}

/** Per-schedule options. */
export interface ScheduleDeliveryOptions {
  /**
   * Hold the delivery back this long before its first attempt on the queue.
   *
   * The run engine attempts a delivery inline before ever scheduling it, so this is the backoff after
   * that first failure. A driver that cannot delay durably must say so — see {@link DeliveryQueue}.
   */
  delayMs?: number;
  /**
   * How many attempts the queue itself will make before giving up, on top of the caller's inline one.
   * A driver that owns the retry schedule uses this to size it.
   */
  attempts?: number;
}

/** What the processor is told about the attempt it is being asked to make. */
export interface DeliveryAttemptContext {
  deliveryId: string;
  /**
   * Which attempt this is, counting the caller's inline one as the first. Recorded on the delivery
   * row, so the admin list and the `X-Skein-Attempt` header report what actually happened rather than
   * the count the row happened to be created with.
   */
  attempt: number;
  /**
   * True when the queue will **not** schedule another attempt if this one fails, so the processor
   * knows to record the delivery `dead` rather than `retrying`.
   *
   * Supplied by the queue rather than derived by the processor, because the queue is what decides:
   * a driver backed by BullMQ knows from the job's own attempt budget, and a processor recomputing
   * that from configuration would disagree with it the moment the two drifted.
   */
  isFinalAttempt: boolean;
}

/**
 * Makes one attempt. **Throws to tell the queue the attempt failed** and another should be scheduled;
 * returns normally when the delivery is settled and needs no further attempts — delivered, dead, or
 * gone.
 */
export type DeliveryProcessor = (context: DeliveryAttemptContext) => Promise<void>;

export interface DeliveryConsumerOptions {
  /** Deliveries attempted at once. Defaults to the driver's own modest bound. */
  concurrency?: number;
}

export interface DeliveryConsumer {
  close(force?: boolean): Promise<void>;
}

/**
 * The scheduler behind outbound deliveries.
 *
 * Optional throughout skein: without one, the delivery worker falls back to polling the store for
 * rows whose `next_attempt_at` has arrived, which is correct but neither push-based nor durable
 * across a restart. **That fallback is the development path.** A production deployment wires the
 * Redis driver, where the whole schedule — delays, exponential backoff, and re-delivery of a job
 * whose worker died — is BullMQ's rather than ours.
 */
export interface DeliveryQueue {
  /**
   * Schedule a delivery. Idempotent on `delivery_id`: scheduling one that is already queued must not
   * produce a second attempt, so a recovery sweep can re-schedule blindly — the same property
   * {@link RunQueue.enqueue} has, and for the same reason.
   */
  schedule(delivery: QueuedDelivery, options?: ScheduleDeliveryOptions): Promise<void>;
  consume(process: DeliveryProcessor, options?: DeliveryConsumerOptions): DeliveryConsumer;
  /**
   * Whether a scheduled delivery survives a process restart.
   *
   * Read to warn, exactly as {@link SkeinStore.durable} is: a deployment whose store is durable but
   * whose delivery schedule is not will lose in-flight retries on every deploy, and a callback that
   * silently stops being retried is worse than one that was never promised.
   */
  readonly durable?: boolean;
}
