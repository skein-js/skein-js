import { fork } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startPostgres, startRedis } from "@skein-js/test-support";

import { percentile } from "./harness/percentiles.js";

interface WorkerEvent {
  kind: "ready" | "reply" | "started" | "finished" | "slots";
  id?: number;
  result?: unknown;
  error?: string;
  jobId?: string;
  threadId?: string;
  at?: number;
  count?: number;
}

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0 ? "results/dispatch.json" : process.argv[outputIndex + 1]!;
const postgres = await startPostgres();
const redis = await startRedis();
const workers = [0, 1].map(() =>
  fork(fileURLToPath(new URL("./dispatch-worker.js", import.meta.url)), {
    env: { ...process.env, DISPATCH_POSTGRES_URI: postgres.url, DISPATCH_REDIS_URI: redis.url },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  }),
);
let commandId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const slots = [0, 0];
let occupiedSlots = 0;
const starts = new Map<string, number>();
const finishes = new Map<string, number>();
const executionThreads = new Map<string, string>();
let readyCount = 0;
let failure: Error | undefined;
for (const [index, worker] of workers.entries()) {
  worker.on("error", (error) => {
    failure = error;
  });
  worker.on("exit", (code) => {
    if (code) failure = new Error(`Worker exited with ${code}`);
  });
  worker.on("message", (event: WorkerEvent) => {
    switch (event.kind) {
      case "ready":
        readyCount++;
        break;
      case "reply": {
        const waiter = pending.get(event.id!);
        pending.delete(event.id!);
        if (event.error) waiter?.reject(new Error(event.error));
        else waiter?.resolve(event.result);
        break;
      }
      case "slots":
        slots[index] = event.count!;
        if (event.count! > 4) failure = new Error("Worker exceeded its execution concurrency");
        occupiedSlots = Math.max(
          occupiedSlots,
          slots.reduce((sum, count) => sum + count, 0),
        );
        break;
      case "started":
        executionThreads.set(event.jobId!, event.threadId!);
        starts.set(event.jobId!, event.at!);
        break;
      case "finished":
        finishes.set(event.jobId!, event.at!);
        break;
    }
  });
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!predicate()) {
    if (failure) throw failure;
    if (Date.now() > deadline) throw new Error("Dispatch benchmark timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (failure) throw failure;
}
async function request(
  index: number,
  operation: string,
  fields: Record<string, unknown> = {},
): Promise<unknown> {
  const id = ++commandId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  workers[index]!.send({ id, operation, ...fields });
  const timeout = setTimeout(
    () => pending.get(id)?.reject(new Error("Worker command timed out")),
    120_000,
  );
  try {
    return await result;
  } finally {
    clearTimeout(timeout);
    pending.delete(id);
  }
}

try {
  await waitFor(() => readyCount === 2);
  const results = [];
  for (const scenario of ["hot-thread", "independent-threads"]) {
    for (let iteration = 0; iteration < 5; iteration++) {
      starts.clear();
      finishes.clear();
      occupiedSlots = 0;
      const created = new Map<string, number>();
      const hotThread = (await request(0, "thread")) as string;
      for (let index = 0; index < 64; index++) {
        const hot = scenario === "hot-thread" && index < 32;
        const threadId = hot ? hotThread : ((await request(0, "thread")) as string);
        const jobId = `${scenario}-${iteration}-${index}`;
        const createdAt = (await request(0, "enqueue", {
          threadId,
          jobId,
          durationMs: hot ? 250 : 25,
        })) as number;
        created.set(jobId, createdAt);
      }
      await Promise.all(workers.map((_, index) => request(index, "start")));
      await waitFor(() => finishes.size === 64);
      await Promise.all(workers.map((_, index) => request(index, "stop")));
      const threadEnds = new Map<string, number>();
      for (const [jobId, at] of [...starts].sort((left, right) => left[1] - right[1])) {
        const threadId = executionThreads.get(jobId)!;
        if ((threadEnds.get(threadId) ?? 0) > at)
          throw new Error("Concurrent execution on one thread");
        threadEnds.set(threadId, finishes.get(jobId)!);
      }
      const cold = [...created.keys()].filter(
        (_, index) => scenario !== "hot-thread" || index >= 32,
      );
      const latencies = cold.map((id) => starts.get(id)! - created.get(id)!);
      const durationMs = Math.max(...finishes.values()) - Math.min(...starts.values());
      const result = {
        scenario,
        iteration,
        coldStartP50Ms: percentile(latencies, 0.5),
        coldStartP95Ms: percentile(latencies, 0.95),
        coldStartP99Ms: percentile(latencies, 0.99),
        runsPerSecond: 64_000 / durationMs,
        occupiedSlots,
      };
      results.push(result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const runtimeRequire = createRequire(import.meta.resolve("@skein-js/runtime"));
  const queueRequire = createRequire(runtimeRequire.resolve("@skein-js/redis"));
  await writeFile(
    output,
    JSON.stringify(
      {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
        node: process.version,
        results,
        dependencies: {
          bullmq: (queueRequire("bullmq/package.json") as { version: string }).version,
          ioredis: (queueRequire("ioredis/package.json") as { version: string }).version,
        },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await Promise.allSettled(workers.map((_, index) => request(index, "dispose")));
  for (const worker of workers) worker.kill("SIGKILL");
  await Promise.allSettled([redis.stop(), postgres.stop()]);
}
