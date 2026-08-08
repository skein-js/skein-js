// Protocol conformance for one serving runtime, driven by the real `@langchain/langgraph-sdk`.
//
// This is the correctness half of the Bun/Deno graduation matrix (PERF-WORKSTREAM.md, P12). It runs in
// CI because runtime co-tenancy does not affect pass/fail — unlike the performance half, which needs a
// machine whose CPU nobody else is using.
//
// Driven by the SDK, not by `fetch`, on purpose: the SDK is what a user's client actually is, and it
// sends parameters a hand-written request would not (`runs.list` always sends `limit`/`offset`). A
// transport that only satisfies curl is not compatible with LangGraph.
//
// The harness itself always runs under Node. Only the SERVER changes runtime — that is the variable.
//
// Usage: node packages/test-support/scripts/runtime-conformance.mjs --runtime node|bun|deno

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@langchain/langgraph-sdk";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const artifactDir = path.join(repoRoot, "packages/test-support/fixtures/runtime-artifact");
const cliEntry = path.join(repoRoot, "packages/cli/dist/index.js");
// Gitignored, and inside the repo so `--allow-read=<repoRoot>` still covers it.
const denoHome = path.join(repoRoot, ".profiles", "deno-home");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const runtime = args.get("runtime") ?? "node";
if (!["node", "bun", "deno"].includes(runtime)) {
  console.error(`unknown runtime "${runtime}" (expected node, bun, or deno)`);
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Kept at module scope so a thrown error can dump what the server said. In CI the server's own log is
// the only evidence available after the fact, and a bare `fetch failed` from the SDK says nothing.
const startedServers = [];

const failures = [];
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures.push(detail === undefined ? label : `${label} — ${detail}`);
  console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  return false;
}

/** Launch `skein start` on the runtime under test. Only the argv differs between the three. */
function startServer(port, env = {}) {
  const serve = [
    cliEntry,
    "start",
    "-c",
    path.join(artifactDir, "langgraph.json"),
    "--runtime",
    runtime,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
  ];
  const options = {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      // Mirrors `ENV HOME=/app` in the generated Deno image: Deno's read permission is scoped to the
      // artifact root, and `langsmith` (via @langchain/core) probes `~/.langsmith/config.json` while
      // building its client. A denial is a throw, so without this every run fails with `NotCapable`.
      //
      // A scratch directory under `.profiles/` (gitignored), NOT the artifact fixture itself: Deno
      // derives its module cache from `$HOME`, so pointing HOME at a committed directory writes nine
      // cache blobs into the repo and dirties the worktree on every run. Still inside `--allow-read`,
      // so it reproduces the image's arrangement faithfully.
      ...(runtime === "deno" ? { HOME: denoHome } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  };

  const child =
    runtime === "deno"
      ? spawn(
          "deno",
          [
            "run",
            "--allow-net",
            "--allow-env",
            `--allow-read=${repoRoot}`,
            "--allow-sys",
            `--allow-ffi=${path.join(repoRoot, "node_modules")}`,
            ...serve,
          ],
          options,
        )
      : spawn(runtime, serve, options);

  const output = [];
  child.stdout?.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => output.push(chunk.toString()));
  const server = { child, output, port };
  startedServers.push(server);
  return server;
}

async function waitForReady(port, server, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`server exited early (${server.child.exitCode}):\n${server.output.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ok`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`server never became ready:\n${server.output.join("")}`);
}

function rssBytes(pid) {
  try {
    return (
      Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(pid)])
          .toString()
          .trim(),
      ) * 1024
    );
  } catch {
    return 0;
  }
}

async function stopServer(server, signal = "SIGTERM", timeoutMs = 20_000) {
  if (server.child.exitCode !== null) return { exitMs: 0, exited: true };
  const startedAt = Date.now();
  server.child.kill(signal);
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline && server.child.exitCode === null) await sleep(100);
  const exited = server.child.exitCode !== null;
  if (!exited) server.child.kill("SIGKILL");
  return { exitMs: Date.now() - startedAt, exited };
}

/** Consume an SDK stream, counting frames and capturing any `error` event the server emitted. */
async function collectStream(stream) {
  const frames = [];
  const errors = [];
  for await (const chunk of stream) {
    frames.push(chunk);
    if (chunk.event === "error") errors.push(chunk.data);
  }
  return { frames, errors };
}

const TERMINAL = ["success", "error", "cancelled", "timeout", "interrupted"];

async function main() {
  console.log(`\n=== runtime conformance: ${runtime} ===\n`);
  if (runtime === "deno") mkdirSync(denoHome, { recursive: true });

  // Small, fast frames for the correctness pass — the burst check below turns the volume up.
  const primary = startServer(2610, { MATRIX_FRAMES: "25", MATRIX_FRAME_BYTES: "256" });
  await waitForReady(2610, primary);
  const client = new Client({ apiUrl: "http://127.0.0.1:2610" });

  console.log("assistants");
  const assistants = await client.assistants.search({ limit: 10 });
  check(
    "the artifact's graph is registered as an assistant",
    assistants.some((assistant) => assistant.graph_id === "tokens"),
    `got ${JSON.stringify(assistants.map((a) => a.graph_id))}`,
  );
  const assistantId = assistants.find((assistant) => assistant.graph_id === "tokens")?.assistant_id;
  const schemas = await client.assistants.getSchemas(assistantId);
  check("the baked schema endpoint answers", schemas !== undefined);

  console.log("threads + streaming run");
  const thread = await client.threads.create();
  const streamed = await collectStream(
    client.runs.stream(thread.thread_id, assistantId, {
      input: { messages: [{ role: "human", content: "go" }] },
      streamMode: "custom",
    }),
  );
  // The assertion that matters most: a sandboxed runtime turns a dependency's file probe into a run
  // failure, and it arrives as an `error` FRAME on a 200 response. Deno shipped exactly this bug.
  check(
    "no error frame on a successful run",
    streamed.errors.length === 0,
    JSON.stringify(streamed.errors[0] ?? null),
  );
  check(
    "every frame the graph produced arrived",
    streamed.frames.filter((frame) => frame.event === "custom").length === 25,
    `got ${streamed.frames.filter((f) => f.event === "custom").length} of 25`,
  );

  console.log("runs.list — the SDK always sends limit/offset");
  // `wait` rather than `create`: the default multitask strategy is `reject`, so firing several runs at
  // one thread is a 422 by design. Each of these settles before the next starts.
  for (let i = 0; i < 3; i += 1) {
    await client.runs.wait(thread.thread_id, assistantId, {
      input: { messages: [{ role: "human", content: `bg ${i}` }] },
    });
  }
  const limited = await client.runs.list(thread.thread_id, { limit: 2 });
  check("a client-supplied limit is honoured", limited.length === 2, `got ${limited.length}`);
  const offset = await client.runs.list(thread.thread_id, { limit: 2, offset: 2 });
  check(
    "offset pages rather than repeating the first page",
    offset.every((run) => !limited.some((first) => first.run_id === run.run_id)),
  );

  console.log("store");
  await client.store.putItem(["runtime", runtime], "key", { value: 1 });
  const item = await client.store.getItem(["runtime", runtime], "key");
  check("an item round-trips", item?.value?.value === 1);
  // `listNamespaces` answers `{ namespaces }`, not a bare array — unlike `runs.list` and
  // `threads.getHistory` above, which do. Reading `.length` off the response object made this
  // `undefined >= 1`, so the check failed on every runtime while the server was answering correctly.
  const { namespaces } = await client.store.listNamespaces({ prefix: ["runtime"], limit: 10 });
  check(
    "namespaces list under a prefix",
    // Assert the namespace we just wrote comes back, not merely that *something* did: a prefix filter
    // that ignored its prefix and returned the whole store would pass a `length >= 1` check.
    namespaces.some((namespace) => namespace[0] === "runtime" && namespace[1] === runtime),
    JSON.stringify(namespaces),
  );

  console.log("history");
  const history = await client.threads.getHistory(thread.thread_id, { limit: 5 });
  check("thread history returns at most the requested limit", history.length <= 5);

  console.log("cross-instance join (two servers, one Postgres + Redis)");
  const secondary = startServer(2611, { MATRIX_FRAMES: "40", MATRIX_FRAME_BYTES: "256" });
  try {
    await waitForReady(2611, secondary);
    const other = new Client({ apiUrl: "http://127.0.0.1:2611" });
    const shared = await client.threads.create();
    const background = await client.runs.create(shared.thread_id, assistantId, {
      input: { messages: [{ role: "human", content: "cross" }] },
      streamMode: ["custom"],
    });
    // Started on the primary, joined from the secondary: this only works if frames travel through
    // Redis rather than through the process that happens to be executing the run.
    const joined = await collectStream(other.runs.joinStream(shared.thread_id, background.run_id));
    check(
      "a run started on one instance streams from the other",
      joined.frames.length > 0,
      `got ${joined.frames.length} frames`,
    );
    check("no error frame across instances", joined.errors.length === 0);

    console.log("burst retention (same measurement twice — a ratio, not a number)");
    const burst = async () => {
      const threads = await Promise.all(Array.from({ length: 20 }, () => client.threads.create()));
      await Promise.all(
        threads.map((each) =>
          collectStream(
            client.runs.stream(each.thread_id, assistantId, {
              input: { messages: [{ role: "human", content: "burst" }] },
              streamMode: "custom",
            }),
          ),
        ),
      );
      await sleep(2000);
      return rssBytes(primary.child.pid);
    };
    const first = await burst();
    const second = await burst();
    // Absolute RSS is unusable on a shared runner; the ratio between two identical bursts is not. A
    // second burst that costs as much as the first again is retention that never plateaus.
    check(
      "a repeated burst does not grow resident memory again",
      second <= first * 1.5,
      `${Math.round(first / 1048576)}MB then ${Math.round(second / 1048576)}MB`,
    );

    console.log("SIGTERM drain");
    const inFlight = await client.runs.create(shared.thread_id, assistantId, {
      input: { messages: [{ role: "human", content: "drain" }] },
    });
    await sleep(1500);
    const stopped = await stopServer(primary);
    check("the process exits on SIGTERM", stopped.exited, `after ${stopped.exitMs}ms`);
    // Read through the OTHER instance: the store outlives the process that was serving.
    const settled = await other.runs.get(shared.thread_id, inFlight.run_id);
    check(
      "an in-flight run lands in a terminal status",
      TERMINAL.includes(settled.status),
      `status=${settled.status}`,
    );
  } finally {
    await stopServer(secondary);
    await stopServer(primary, "SIGKILL", 5000);
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed on ${runtime}`);
  if (failures.length > 0) {
    console.error(`\n${runtime} FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\n${runtime} harness error:`, error);
  for (const server of startedServers) {
    console.error(
      `\n--- server :${server.port} (exit ${server.child.exitCode}) ---\n${server.output.join("")}`,
    );
    if (server.child.exitCode === null) server.child.kill("SIGKILL");
  }
  process.exit(1);
});
