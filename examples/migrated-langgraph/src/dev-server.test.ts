// The headline drop-in proof: run the real `skein dev` CLI against this stock LangGraph project and
// drive it with the official `@langchain/langgraph-sdk` client — then restart it and confirm the
// thread survived (persistence across shutdowns). This exercises the whole `skein dev` path: vite
// TS loading, the in-process Express server, SSE streaming, and `.skein/` persistence.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exampleDir = fileURLToPath(new URL("..", import.meta.url));
const stateDir = path.join(exampleDir, ".skein");

// The built `skein` CLI, via the workspace-linked package. If it hasn't been built yet, skip rather
// than fail — `nx build` (which the verify flow runs first) produces it; a bare `nx test` may not.
function resolveSkeinBin(): string | undefined {
  const bin = path.join(exampleDir, "node_modules", "skein-js", "dist", "index.js");
  return existsSync(bin) ? bin : undefined;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Spawn `skein dev`, resolving once its startup banner reports the server is running. */
async function startDev(bin: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [bin, "dev", "--port", String(port), "--host", "127.0.0.1"],
    { cwd: exampleDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for skein dev")), 25_000);
    const onData = (buffer: Buffer) => {
      // The banner prints this on stdout only after `server.listen` succeeds (see banner.ts).
      if (buffer.toString().includes("Server running at")) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (b: Buffer) => process.stderr.write(b));
    child.once("exit", (code) =>
      reject(new Error(`skein dev exited early (code ${String(code)})`)),
    );
  });
  return child;
}

/** SIGINT the dev server and wait for it to exit (it saves state on the way out). */
function stopDev(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGINT");
  });
}

const bin = resolveSkeinBin();

describe.skipIf(!bin)("skein dev over @langchain/langgraph-sdk (drop-in + persistence)", () => {
  let port: number;
  let url: string;
  let child: ChildProcess;
  let threadId: string;

  beforeAll(async () => {
    rmSync(stateDir, { recursive: true, force: true });
    port = await freePort();
    url = `http://127.0.0.1:${port}`;
    child = await startDev(bin as string, port);
  });

  afterAll(async () => {
    if (child) await stopDev(child);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("runs the stock LangGraph graph via the official SDK", async () => {
    const client = new Client({ apiUrl: url });
    const thread = await client.threads.create();
    threadId = thread.thread_id;

    const values = await client.runs.wait(threadId, "agent", {
      input: { messages: [{ role: "user", content: "hello" }] },
    });

    expect(JSON.stringify(values)).toContain("you said: hello");
  });

  it("keeps the thread after a full restart (state persisted to .skein/)", async () => {
    await stopDev(child);
    child = await startDev(bin as string, port);

    const client = new Client({ apiUrl: url });
    const restored = await client.threads.get(threadId);
    expect(restored.thread_id).toBe(threadId);
  });
});
