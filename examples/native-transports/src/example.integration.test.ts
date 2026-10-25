import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { startRedis } from "@skein-js/test-support";
import { expect, it } from "vitest";

function launch(entry: string, environment: Record<string, string>) {
  const child = spawn(process.execPath, [resolve("dist", `${entry}.js`)], {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const finished = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${entry} exited ${code}: ${stderr}`)),
    );
  });
  // Attach rejection handling immediately; the test may be waiting for backend readiness.
  void finished.catch(() => undefined);
  return { child, finished, output: () => stdout };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

it("runs the embedded example twice with the same durable receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-native-example-"));
  try {
    const environment = { SKEIN_SQLITE_PATH: join(directory, "embedded.sqlite") };
    const first = JSON.parse(await launch("embedded", environment).finished);
    const reopened = JSON.parse(await launch("embedded", environment).finished);
    expect(reopened.receipt).toEqual(first.receipt);
    expect(reopened.status).toBe("interrupted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("serves HTTP and BullMQ, survives backend/receiver restart, and reconciles duplicate commands", async () => {
  const redis = await startRedis();
  const directory = await mkdtemp(join(tmpdir(), "skein-bullmq-example-"));
  const environment = {
    REDIS_URI: redis.url,
    PORT: "0",
    SKEIN_SQLITE_PATH: join(directory, "backend.sqlite"),
    SKEIN_RECEIVER_PATH: join(directory, "receiver.sqlite"),
  };
  let backend: ReturnType<typeof launch> | undefined;
  try {
    backend = launch("backend", environment);
    await expect.poll(() => backend!.output(), { timeout: 15_000 }).toContain('"ready":true');
    const ready = JSON.parse(backend.output().trim().split("\n").at(-1)!);
    const http = await fetch(`http://127.0.0.1:${ready.port}/threads`, {
      method: "POST",
      headers: { authorization: "Bearer local-example", "content-type": "application/json" },
      body: "{}",
    });
    expect(http.status).toBe(200);
    const first = JSON.parse(await launch("producer", environment).finished);
    expect(first.result.decision).toBe("approved");
    await stop(backend.child);
    await backend.finished;
    backend = launch("backend", environment);
    await expect.poll(() => backend!.output(), { timeout: 15_000 }).toContain('"ready":true');
    const duplicate = JSON.parse(await launch("producer", environment).finished);
    expect(duplicate.receipt).toEqual(first.receipt);
    expect(duplicate.answer).toEqual(first.answer);
    expect(duplicate.result).toEqual(first.result);
    const inbox = new DatabaseSync(environment.SKEIN_RECEIVER_PATH);
    try {
      expect(inbox.prepare("SELECT count(*) AS count FROM outcomes").get()?.["count"]).toBe(2);
    } finally {
      inbox.close();
    }
  } finally {
    if (backend) await stop(backend.child);
    await redis.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
