import { runError, type RunKwargs } from "@skein-js/core";
import type { Database } from "better-sqlite3";

import { insertDelivery } from "./insert-delivery.js";

/** Called only after the connection has acquired and retained exclusive file ownership. */
export function reconcileAbandonedRuns(database: Database): void {
  const failure = runError("ProcessLostError", "The process ended before this run completed.");
  const select =
    database.prepare(`SELECT r.key,r.thread_id,r.kwargs FROM skein_runs r LEFT JOIN skein_run_jobs j ON j.run_id=r.key
    WHERE r.status IN ('pending','running') AND
    (r.status='running' OR j.status='active' OR json_extract(r.kwargs,'$.queue_not_before') IS NULL)
    LIMIT 128`);
  const retire = database.prepare("UPDATE skein_run_jobs SET status='done' WHERE run_id=?");
  const fail = database.prepare(
    "UPDATE skein_runs SET body=json_set(body,'$.status','error','$.error',json(?),'$.updated_at',?) WHERE key=?",
  );
  const failThread =
    database.prepare(`UPDATE skein_threads SET body=json_set(body,'$.status','error','$.error',?,'$.updated_at',?) WHERE key=? AND (json_extract(body,'$.status')='busy' OR (json_extract(body,'$.status') <> 'interrupted' AND
    (SELECT key FROM skein_runs WHERE thread_id=? ORDER BY json_extract(body,'$.created_at') DESC,key DESC LIMIT 1)=?))`);
  const batch = database.transaction(() => {
    const rows = select.all() as { key: string; thread_id: string; kwargs: string | null }[];
    const at = new Date().toISOString();
    for (const row of rows) {
      fail.run(JSON.stringify(failure), at, row.key);
      retire.run(row.key);
      failThread.run(failure.message, at, row.thread_id, row.thread_id, row.key);
      const template = row.kwargs
        ? (JSON.parse(row.kwargs) as RunKwargs).terminal_delivery
        : undefined;
      if (
        template &&
        !database.prepare("SELECT 1 FROM skein_deliveries WHERE key=?").get(template.delivery_id)
      ) {
        const retentionMs = Date.parse(template.expires_at) - Date.parse(template.next_attempt_at);
        insertDelivery(
          database,
          row.key,
          "error",
          {
            ...template,
            payload: {
              ...(template.payload as Record<string, unknown>),
              error: failure.message,
              result_unavailable: true,
            },
            next_attempt_at: at,
            expires_at: new Date(Date.parse(at) + retentionMs).toISOString(),
          },
          false,
        );
      }
    }
    return rows.length;
  });
  while (batch() > 0) {
    /* all matching rows, independently of public page bounds */
  }
  let cursor = "";
  const stale =
    database.prepare(`SELECT t.key, r.body FROM skein_threads t JOIN skein_runs r ON r.key =
    (SELECT key FROM skein_runs WHERE thread_id=t.key AND status NOT IN ('pending','running') ORDER BY json_extract(body,'$.updated_at') DESC,key DESC LIMIT 1)
    WHERE t.key>? AND json_extract(t.body,'$.status')='busy' AND r.status NOT IN ('pending','running') ORDER BY t.key LIMIT 128`);
  const repair = database.transaction(() => {
    const rows = stale.all(cursor) as { key: string; body: string }[];
    for (const row of rows) {
      const run = JSON.parse(row.body);
      const status =
        run.status === "interrupted"
          ? "interrupted"
          : ["error", "timeout"].includes(run.status)
            ? "error"
            : "idle";
      database
        .prepare(
          "UPDATE skein_threads SET body=json_set(json_remove(body,'$.error'),'$.status',?,'$.updated_at',?) WHERE key=?",
        )
        .run(status, new Date().toISOString(), row.key);
      if (status === "error" && run.error?.message)
        database
          .prepare("UPDATE skein_threads SET body=json_set(body,'$.error',?) WHERE key=?")
          .run(run.error.message, row.key);
      cursor = row.key;
    }
    return rows.length;
  });
  while (repair() > 0) {
    /* bounded mirror repair */
  }
  const retireJobs = database.prepare(`UPDATE skein_run_jobs SET status='done' WHERE sequence IN
    (SELECT j.sequence FROM skein_run_jobs j LEFT JOIN skein_runs r ON r.key=j.run_id
      WHERE j.status='active' OR (j.status='waiting' AND r.status NOT IN ('pending','running')) LIMIT 128)`);
  while (retireJobs.run().changes > 0) {
    /* bounded retirement, including orphaned claimed jobs */
  }
}
