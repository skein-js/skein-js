// Redis-backed run queue on BullMQ: a durable job queue whose workers pull and execute runs
// across instances, with retries/backoff and lease-based crash recovery (a stalled job whose
// worker died is moved back to wait) handled by BullMQ itself. The run worker talks only to the
// `RunQueue` interface, so it is unaware it holds this rather than the in-memory queue
// (see docs/runs-and-redis.md).

import type {
  EnqueueOptions,
  QueuedRun,
  RunConsumer,
  RunConsumerOptions,
  RunProcessor,
  RunQueue,
} from "@skein-js/core";
import { Queue, Worker } from "bullmq";

import { settleBullConnection } from "./redis-connection.js";

const JOB_NAME = "run";

/** Options for {@link RedisRunQueue} — the BullMQ queue name and per-run retry attempts. */
export interface RedisRunQueueOptions {
  /** BullMQ queue name; also namespaces the Redis keys. Must not contain `:`. Default `"skein-runs"`. */
  queueName?: string;
  /**
   * How many times BullMQ retries a run whose processor *throws* before giving up. Default 1
   * (no retry). Crash recovery is separate — a stalled job (worker died mid-run) is always
   * recovered — and re-delivery is safe because the processor skips runs already terminal in the store.
   */
  attempts?: number;
}

/** BullMQ-backed `RunQueue`. Owns its connections; call {@link dispose} to release them. */
export class RedisRunQueue implements RunQueue {
  readonly #queue: Queue<QueuedRun>;
  readonly #url: string;
  readonly #queueName: string;
  readonly #attempts: number;
  readonly #workers = new Set<Worker<QueuedRun>>();

  constructor(url: string, options: RedisRunQueueOptions = {}) {
    this.#url = url;
    this.#queueName = options.queueName ?? "skein-runs";
    this.#attempts = options.attempts ?? 1;
    this.#queue = new Queue<QueuedRun>(this.#queueName, { connection: { url } });
  }

  async enqueue(run: QueuedRun, options: EnqueueOptions = {}): Promise<void> {
    await this.#queue.add(
      JOB_NAME,
      { run_id: run.run_id, thread_id: run.thread_id },
      {
        // `after_seconds`, handed to BullMQ's own delayed set — it holds the job in Redis and promotes
        // it when due, so the delay survives a process restart rather than living in a local timer.
        //
        // Note this composes with `jobId` below: a run already sitting delayed is not re-added, so the
        // cron sweep's blind re-enqueue cannot cut a delay short or double-schedule it.
        ...(options.delayMs !== undefined && options.delayMs > 0 ? { delay: options.delayMs } : {}),
        // Keyed on the run id, which makes enqueue **idempotent**: BullMQ refuses a second job with
        // an id already in the queue. That is what lets the cron scheduler's outbox sweep re-enqueue
        // a run it cannot prove was queued, without risking a double execution. A run is one-shot
        // and `removeOnComplete` drops it once it finishes, so the id is never reused.
        //
        // Prefixed rather than passed bare: BullMQ rejects a custom id that parses as an integer
        // ("Custom Id cannot be integers"), because those collide with its own auto-increment id
        // space. skein does not constrain `run_id` format — a caller may supply one on create — so a
        // bare id would turn a numeric run id into a 500 on enqueue only, long after it was accepted.
        jobId: `${JOB_NAME}-${run.run_id}`,
        attempts: this.#attempts,
        // Completed runs live in the store, so drop them from Redis.
        removeOnComplete: true,
        // Failed jobs are dropped too, which is a change of posture that `jobId` forces. BullMQ
        // treats a retained job as still occupying its id: `add` with the same `jobId` returns the
        // existing job without queueing anything. So a retained *failed* job would make that run
        // permanently un-re-enqueueable — the cron scheduler's recovery sweep would call `enqueue`,
        // get a silent no-op, and warn about the same run on every tick forever.
        //
        // Little is lost: a run that failed records its status *and* its `RunError` on its own row
        // (`RunRepo.setStatus`), which outlives Redis and is what `GET /threads/{tid}/runs/{rid}`
        // reads. The retained job carried no information the store does not.
        removeOnFail: true,
      },
    );
  }

  consume(process: RunProcessor, options: RunConsumerOptions = {}): RunConsumer {
    const worker = new Worker<QueuedRun>(this.#queueName, (job) => process(job.data), {
      connection: { url: this.#url },
      concurrency: options.concurrency ?? 1,
    });
    this.#workers.add(worker);
    return {
      close: async (force = false) => {
        this.#workers.delete(worker);
        // A forced close is the caller saying "don't wait" — honour that and skip the settle.
        if (!force) await settleBullConnection(worker);
        await worker.close(force);
      },
    };
  }

  /** Release the queue's connections and close any still-open consumers. */
  async dispose(): Promise<void> {
    // Let each connection finish handshaking before closing it: BullMQ opens them eagerly in the
    // constructor, so tearing down a queue that was built but never used lands mid-handshake and
    // orphans ioredis's own CLIENT SETINFO / INFO as unhandled rejections. See settleBullConnection.
    await Promise.all(
      [...this.#workers].map(async (worker) => {
        await settleBullConnection(worker);
        await worker.close();
      }),
    );
    this.#workers.clear();
    await settleBullConnection(this.#queue);
    await this.#queue.close();
  }
}
