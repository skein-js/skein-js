import { toRunError, type RunQueue } from "@skein-js/core";
import type { Database } from "better-sqlite3";

/** One owner can notify consumers directly; only delayed work needs a timer. */
export function createSqliteQueue(database: Database): RunQueue & {
  wake(): void;
  dispose(): Promise<void>;
} {
  const consumers = new Set<{ close(force?: boolean): Promise<void> }>();
  const listeners = new Set<() => void>();
  let disposed = false;
  const wake = (): void => {
    for (const listener of listeners) listener();
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
    consume(process, options) {
      const concurrency = options?.concurrency ?? 1;
      if (!Number.isInteger(concurrency) || concurrency < 1)
        throw new Error("Queue concurrency must be a positive integer.");
      if (disposed) throw new Error("SQLite queue is disposed.");
      let closed = false;
      let scheduled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const running = new Set<Promise<void>>();
      const claim = database.transaction(() => {
        const job = database
          .prepare(
            "SELECT run_id,thread_id FROM skein_run_jobs WHERE status='waiting' AND due_at<=? ORDER BY sequence LIMIT 1",
          )
          .get(Date.now()) as { run_id: string; thread_id: string } | undefined;
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
          const attempt = Promise.resolve()
            .then(() => process(job))
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
                  .prepare("UPDATE skein_run_jobs SET status='done' WHERE run_id=?")
                  .run(job.run_id);
              running.delete(attempt);
              notify();
            });
          running.add(attempt);
        }
        if (running.size >= concurrency) return;
        const next = database
          .prepare("SELECT min(due_at) AS due_at FROM skein_run_jobs WHERE status='waiting'")
          .get() as { due_at: number | null };
        if (next.due_at !== null) {
          timer = setTimeout(
            notify,
            Math.min(2_147_483_647, Math.max(1, next.due_at - Date.now())),
          );
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
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all([...consumers].map((consumer) => consumer.close()));
    },
  };
}
