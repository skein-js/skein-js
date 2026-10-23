import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { openSqliteStorage } from "./index.js";

it.each([false, true])(
  "keeps a result after SIGKILL with terminal status committed=%s",
  async (terminal) => {
    const directory = await mkdtemp(join(tmpdir(), "skein-result-kill-"));
    const filename = join(directory, "state.sqlite");
    const childFile = join(directory, "child.mjs");
    await writeFile(
      childFile,
      `import {openSqliteStorage} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const storage=await openSqliteStorage({filename:${JSON.stringify(filename)}});
    const thread=await storage.store.threads.create();
    const run=await storage.store.runs.create({thread_id:thread.thread_id,assistant_id:'agent'});
    await storage.store.runs.recordResult(run.run_id,{values:{answer:'original'}});
    ${terminal ? "await storage.store.runs.setStatus(run.run_id,'success');" : ""}
    process.send({runId:run.run_id}); setInterval(()=>{},1000);`,
    );
    const child = fork(childFile, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors += String(chunk);
    });
    try {
      const [message] = (await Promise.race([
        once(child, "message"),
        once(child, "exit").then(() => {
          throw new Error(errors || "Child exited early");
        }),
      ])) as [{ runId: string }];
      child.kill("SIGKILL");
      await once(child, "exit");
      const reopened = await openSqliteStorage({ filename });
      try {
        expect(await reopened.store.runs.getResult!(message.runId)).toEqual({
          values: { answer: "original" },
        });
        expect((await reopened.store.runs.get(message.runId))?.status).toBe(
          terminal ? "success" : "error",
        );
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
