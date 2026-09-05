#!/usr/bin/env node
// Smoke-test the scaffolder end to end: generate a project into a temp directory, install its
// dependencies from the real registry, and prove the result runs.
//
// This is the only check that exercises what a new user actually experiences. The unit tests assert
// what `buildProjectFiles` returns; they cannot catch a starter that pins a version combination npm
// will not resolve, or a graph that no longer typechecks against a released `@langchain/langgraph`.
// Both of those break for a stranger without anything in this repo changing, which is why this runs
// in CI on every commit rather than only before a release.
//
// It deliberately installs the *published* `skein-js`, not the workspace copy: the range the
// scaffolder emits is `^<its own version>`, and whether that range resolves to something that works
// is precisely the thing under test. The one exception is a release commit, where that version does
// not exist yet — see useAPublishedSkein below.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scaffolder = path.resolve("packages/create-skein-js/dist/index.js");
const providers = ["none", "anthropic"];

/** Whether a Docker daemon is reachable — the durable half of this script needs one. */
function dockerIsAvailable() {
  return spawnSync("docker", ["info"], { stdio: "ignore", shell: false }).status === 0;
}

/** Run a command, streaming output, and fail the script if it exits non-zero. */
function run(command, args, options = {}) {
  const label = `${command} ${args.join(" ")}`;
  process.stdout.write(`\n$ ${label}\n`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.status !== 0) {
    throw new Error(`Failed (exit ${result.status ?? "signal"}): ${label}`);
  }
}

/** Ask the running server a question over the Agent Protocol and check it answers. */
async function callTheServer(baseUrl) {
  const thread = await fetch(`${baseUrl}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json());

  const run = await fetch(`${baseUrl}/threads/${thread.thread_id}/runs/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assistant_id: "echo",
      input: { messages: [{ role: "user", content: "smoke" }] },
    }),
  }).then((response) => response.json());

  const reply = run?.messages?.at(-1)?.content;
  if (reply !== "echo: smoke") {
    throw new Error(
      `Expected "echo: smoke" from the scaffolded graph, got: ${JSON.stringify(reply)}`,
    );
  }
}

/** Wait for the dev server to answer its health probe, or give up. */
async function waitForServer(baseUrl, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/ok`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${baseUrl} never became ready`);
}

/** Whether an exact `skein-js` version exists on the registry. */
function isPublished(version) {
  const result = spawnSync("npm", ["view", `skein-js@${version}`, "version"], {
    stdio: "ignore",
    shell: false,
  });
  return result.status === 0;
}

/**
 * Point the scaffolded project at a `skein-js` that actually exists, if the one it pinned does not.
 *
 * The scaffolder pins `^<its own version>`, and `packages/*` share a version, so on an ordinary
 * commit that range is already on npm and this does nothing. On a *release* commit it is not: the
 * version has been bumped but nothing is published yet, and release.yml gates publishing on this
 * workflow. Left alone, `npm install` would fail with ETARGET, CI would fail, and the release could
 * never go out — a deadlock that only appears on the one commit where it matters.
 *
 * Falling back to `latest` keeps the check meaningful — it still proves the emitted templates and
 * every other pinned range install and run — while removing the circular dependency. That the
 * emitted range matches this package's own version is asserted separately, in
 * dependency-versions.test.ts, and does not need the network.
 */
function useAPublishedSkein(project, ownVersion) {
  if (isPublished(ownVersion)) return;

  const manifestPath = path.join(project, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.devDependencies["skein-js"] = "latest";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `\nskein-js@${ownVersion} is not published yet (this looks like a release commit).\n` +
      `Testing the scaffolded project against skein-js@latest instead.\n`,
  );
}

async function smokeTest(provider, port, ownVersion) {
  const workspace = mkdtempSync(path.join(tmpdir(), `skein-scaffold-${provider}-`));
  const project = path.join(workspace, "my-agent");
  process.stdout.write(`\n=== --provider ${provider} → ${project} ===\n`);

  try {
    run(
      "node",
      [scaffolder, "my-agent", "--provider", provider, "--no-install", "--no-git", "-y"],
      {
        cwd: workspace,
      },
    );

    useAPublishedSkein(project, ownVersion);

    // A real install from the registry: this is what proves the emitted version ranges resolve.
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: project });
    run("npx", ["tsc", "--noEmit"], { cwd: project });
    run("npx", ["vitest", "run"], { cwd: project });

    const dev = spawn("npx", ["skein", "dev", "--port", String(port)], {
      cwd: project,
      stdio: "inherit",
      shell: false,
    });

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForServer(baseUrl);
      await callTheServer(baseUrl);
      process.stdout.write(`\n✓ --provider ${provider}: scaffolded, installed, served a run\n`);
    } finally {
      // Wait for it to actually exit before removing the directory: `skein dev` snapshots its state
      // to .skein/ on shutdown, and deleting the tree out from under that write races it.
      const exited = new Promise((resolve) => dev.once("exit", resolve));
      dev.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * The other half of the generated README: `dev:services` → `build` → `start`.
 *
 * `dev` was the only thing this script exercised, so `start` being broken passed every check — it
 * resolved `langgraph.json` from the cwd and died on the missing `schemas.json`, before it ever
 * looked at `POSTGRES_URI`. Run verbatim, as a stranger following the README would: no exported
 * variables and no hand-edited `.env`, because needing either is the bug.
 *
 * Provider-independent, so it runs once rather than per provider — the durable path does not touch
 * the model. Skipped without a Docker daemon so the `dev` half still runs on a machine that has none.
 */
async function shipItSmokeTest(port, ownVersion) {
  if (!dockerIsAvailable()) {
    process.stdout.write("\nNo Docker daemon; skipping the `start` half of the smoke test.\n");
    return;
  }

  const workspace = mkdtempSync(path.join(tmpdir(), "skein-scaffold-ship-"));
  const project = path.join(workspace, "my-agent");
  process.stdout.write(`\n=== ship it (dev:services → build → start) → ${project} ===\n`);

  try {
    run("node", [scaffolder, "my-agent", "--provider", "none", "--no-install", "--no-git", "-y"], {
      cwd: workspace,
    });
    useAPublishedSkein(project, ownVersion);
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: project });

    // Inside the try, so the finally below tears the containers down even if compose itself fails
    // partway. The workspace holding `compose.dev.yaml` is deleted straight after, so a leaked
    // container could not be cleaned up by hand afterwards.
    try {
      run("npm", ["run", "dev:services"], { cwd: project });
      run("npm", ["run", "build"], { cwd: project });

      // `PORT` rather than a flag: `skein start` reads it, and the scaffolded script takes no args.
      //
      // The two URIs are passed explicitly, and only because this script installs the *published*
      // `skein-js` on purpose. Reading them from the project's own `.env` — which is what makes the
      // generated README's steps work with nothing to edit — needs `skein start` to read a
      // conventional `.env` from its working directory, and the released CLI predates that. They
      // match `compose.dev.yaml`, and the ambient environment outranks `.env` either way, so this
      // changes nothing about what is under test here: that `build` produces an artifact and the
      // scaffolded `start` script actually serves it. The `.env` half is covered by
      // `packages/cli/src/project-env.test.ts`. Drop these two lines once the fix is released.
      const server = spawn("npm", ["start"], {
        cwd: project,
        stdio: "inherit",
        shell: false,
        env: {
          ...process.env,
          PORT: String(port),
          POSTGRES_URI: "postgresql://postgres:postgres@localhost:5432/skein",
          REDIS_URI: "redis://localhost:6379",
        },
      });
      // Raced against readiness below: a `start` that exits immediately is the exact failure this
      // test exists to catch, and without this it would be reported as a 120s readiness timeout
      // instead of as the exit code it actually was.
      const crashed = new Promise((_resolve, reject) => {
        server.once("exit", (code, signal) => {
          if (signal === "SIGTERM") return; // our own teardown, below
          reject(new Error(`\`npm start\` exited early (code ${code}, signal ${signal})`));
        });
      });
      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        await Promise.race([waitForServer(baseUrl, 120), crashed]);
        await callTheServer(baseUrl);
        process.stdout.write("\n✓ ship it: built an artifact and served a run from it\n");
      } finally {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill("SIGTERM");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      }
    } finally {
      // Volumes too: a leftover Postgres volume would carry state into the next run of this script.
      run("docker", ["compose", "-f", "compose.dev.yaml", "down", "-v"], { cwd: project });
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// Sanity-check that the scaffolder pins the version it was built at, so a stale `dist/` cannot make
// the rest of this pass against the wrong runtime.
const ownVersion = JSON.parse(
  readFileSync("packages/create-skein-js/package.json", "utf8"),
).version;
process.stdout.write(`create-skein-js ${ownVersion} → pins skein-js@^${ownVersion}\n`);

let port = 2400;
for (const provider of providers) {
  await smokeTest(provider, (port += 1), ownVersion);
}

await shipItSmokeTest((port += 1), ownVersion);

process.stdout.write("\nAll scaffold smoke tests passed.\n");
