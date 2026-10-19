import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { openSqliteStorage } from "./index.js";

// Children import the built library, with a fresh OS process and real SQLite file ownership.
const entry = new URL("../dist/index.js", import.meta.url).href;
describe("process loss", () => {
  it.each(["before-enqueue", "before-commit", "after-commit", "claimed", "executing"])(
    "survives SIGKILL %s without replaying abandoned input",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "skein-kill-"));
      const filename = join(directory, "state.sqlite");
      const script = join(directory, "child.mjs");
      await writeFile(
        script,
        `import {openSqliteStorage} from ${JSON.stringify(entry)};
      const storage=await openSqliteStorage({filename:${JSON.stringify(filename)}});
      const thread=await storage.store.threads.create();
      if(["before-commit","after-commit"].includes(${JSON.stringify(mode)})) storage.database.exec("BEGIN IMMEDIATE");
      const run=await storage.store.runs.create({thread_id:thread.thread_id,assistant_id:'a',kwargs:{input:{original:true},queue_not_before:new Date(Date.now()+(["before-enqueue","before-commit","after-commit"].includes(${JSON.stringify(mode)})?60000:0)).toISOString()}});
      if(${JSON.stringify(mode)}==='after-commit') storage.database.exec("COMMIT");
      if(["before-enqueue","before-commit","after-commit"].includes(${JSON.stringify(mode)})) {process.send({run,thread});setInterval(()=>{},1000);}
      else {storage.queue.consume(async()=>{if(${JSON.stringify(mode)}==='executing') await storage.store.runs.setStatus(run.run_id,'running');process.send({run,thread});await new Promise(()=>{});});setInterval(()=>{},1000);}`,
      );
      const child = fork(script, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let errors = "";
      child.stderr?.on("data", (chunk) => {
        errors += String(chunk);
      });
      try {
        const message = (await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error(errors || "Child exited before ready");
          }),
        ])) as [{ run: { run_id: string }; thread: { thread_id: string } }];
        child.kill("SIGKILL");
        await once(child, "exit");
        const reopened = await openSqliteStorage({ filename });
        try {
          const run = await reopened.store.runs.get(message[0].run.run_id);
          if (mode === "before-commit") {
            expect(run).toBeNull();
            expect(
              reopened.database.prepare("SELECT count(*) AS count FROM skein_run_jobs").get(),
            ).toEqual({ count: 0 });
          } else if (["before-enqueue", "after-commit"].includes(mode)) {
            expect(run?.status).toBe("pending");
            expect(
              reopened.database.prepare("SELECT count(*) AS count FROM skein_run_jobs").get(),
            ).toEqual({ count: 1 });
          } else {
            expect(run?.status).toBe("error");
            expect(run?.error?.name).toBe("ProcessLostError");
          }
          const received: string[] = [];
          const consumer = reopened.queue.consume(async (job) => {
            received.push(job.run_id);
          });
          await new Promise((resolve) => setTimeout(resolve, 40));
          await consumer.close();
          expect(received).toEqual([]);
        } finally {
          await reopened.dispose();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
  it("requires a real built entry rather than falling back to source aliases", () => {
    expect(fileURLToPath(entry)).toContain("dist/index.js");
  });
});
