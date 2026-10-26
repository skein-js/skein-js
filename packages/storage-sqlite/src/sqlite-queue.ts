import { toRunError, type RunQueue, type QueuedRun, type RunConsumerOptions } from "@skein-js/core";
import type { Database } from "better-sqlite3";

/** One owner can notify consumers directly; only delayed work needs a timer. */
export function createSqliteQueue(database: Database): RunQueue & {
  wake(): void;
  dispose(): Promise<void>;
} {
  const consumers = new Set<{ close(force?: boolean): Promise<void> }>();
  const listeners = new Set<() => void>();
  let disposed = false;
  const deferredThreads = new Map<string, ReturnType<typeof setTimeout>>();
  const wake = (): void => {
    for (const listener of listeners) listener();
  };
  const consume = (
    process: (run: QueuedRun) => Promise<boolean | void>,
    options: RunConsumerOptions | undefined,
    partitioned: boolean,
  ) => {
    const concurrency = options?.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("Queue concurrency must be a positive integer.");
    if (disposed) throw new Error("SQLite queue is disposed.");
    let closed = false;
    let scheduled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = new Set<Promise<void>>();
    const claim = database.transaction(() => {
      const excluded = partitioned ? [...deferredThreads.keys()] : [];
      const job = database
        .prepare(
          `SELECT run_id,thread_id FROM skein_run_jobs j WHERE status='waiting' AND due_at<=?
              ${partitioned ? "AND NOT EXISTS (SELECT 1 FROM skein_run_jobs a WHERE a.thread_id=j.thread_id AND a.status='active')" : ""}
              ${excluded.length ? `AND thread_id NOT IN (${excluded.map(() => "?").join(",")})` : ""}
              ORDER BY sequence LIMIT 1`,
        )
        .get(Date.now(), ...excluded) as { run_id: string; thread_id: string } | undefined;
      if (job)
        database
          .prepare("UPDATE skein_run_jobs SET status='active' WHERE run_id=?")
          .run(job.run_id);
      return job;
    });
    const notify = (): void => {
      if (closed || disposed || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        tick();
      });
    };
    const tick = (): void => {
      if (closed || disposed) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      while (running.size < concurrency) {
        const job = claim();
        if (!job) break;
        let handled = true;
        const attempt = Promise.resolve()
          .then(() => process(job))
          .then((result) => {
            if (partitioned && result === false) {
              handled = false;
              if (!deferredThreads.has(job.thread_id)) {
                const timer = setTimeout(() => {
                  deferredThreads.delete(job.thread_id);
                  wake();
                }, 50);
                timer.unref();
                deferredThreads.set(job.thread_id, timer);
              }
            }
          })
          .catch((error: unknown) => {
            if (!database.open) return;
            database
              .prepare(
                `UPDATE skein_runs SET body=json_set(body,'$.status','error','$.updated_at',?,
              '$.error',json(?)) WHERE key=? AND status IN ('pending','running')`,
              )
              .run(new Date().toISOString(), JSON.stringify(toRunError(error)), job.run_id);
          })
          .finally(() => {
            if (database.open)
              database
                .prepare("UPDATE skein_run_jobs SET status=? WHERE run_id=?")
                .run(handled ? "done" : "waiting", job.run_id);
            running.delete(attempt);
            wake();
          });
        running.add(attempt);
      }
      if (running.size >= concurrency) return;
      const excluded = partitioned ? [...deferredThreads.keys()] : [];
      const next = database
        .prepare(
          `SELECT min(due_at) AS due_at FROM skein_run_jobs j WHERE status='waiting'
              ${partitioned ? "AND NOT EXISTS (SELECT 1 FROM skein_run_jobs a WHERE a.thread_id=j.thread_id AND a.status='active')" : ""}
              ${excluded.length ? `AND thread_id NOT IN (${excluded.map(() => "?").join(",")})` : ""}`,
        )
        .get(...excluded) as { due_at: number | null };
      if (next.due_at !== null) {
        timer = setTimeout(notify, Math.min(2_147_483_647, Math.max(1, next.due_at - Date.now())));
        timer.unref();
      }
    };
    const consumer = {
      async close(force = false): Promise<void> {
        closed = true;
        if (timer) clearTimeout(timer);
        listeners.delete(notify);
        consumers.delete(consumer);
        if (!force) await Promise.all(running);
      },
    };
    consumers.add(consumer);
    listeners.add(notify);
    notify();
    return consumer;
  };
  return {
    wake,
    async enqueue(run, options) {
      if (disposed) throw new Error("SQLite queue is disposed.");
      database
        .prepare(
          "INSERT INTO skein_run_jobs(run_id,thread_id,due_at) VALUES (?,?,?) ON CONFLICT(run_id) DO NOTHING",
        )
        .run(run.run_id, run.thread_id, Date.now() + Math.max(0, options?.delayMs ?? 0));
      wake();
    },
    consume: (process, options) => consume(process, options, false),
    consumePartitioned: (process, options) => consume(process, options, true),
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of deferredThreads.values()) clearTimeout(timer);
      deferredThreads.clear();
      await Promise.all([...consumers].map((consumer) => consumer.close()));
    },
  };
}
