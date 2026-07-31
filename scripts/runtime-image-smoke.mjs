// Build the production image for one runtime from local sources, run it under the small deployment
// shape, and assert it actually serves.
//
// Why local sources need any work at all: `skein build` pins `skein-js` to the CLI's own **published**
// version, so an image built from an unreleased tree installs the last release from npm — and its CMD
// then passes flags that version does not understand. Every `@skein-js/*` package is packed and wired
// in as `file:` dependencies, which is what makes the artifact install *this* commit.
//
// The context is the committed `runtime-artifact` fixture, not a fresh `skein build`: bundling happens
// on the host under Node whatever the target runtime is, so rebuilding it per runtime would add a step
// that cannot differ between them. See that fixture's README.
//
// Usage: node scripts/runtime-image-smoke.mjs --runtime node|bun|deno [--keep]

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactFixture = path.join(repoRoot, "packages/test-support/fixtures/runtime-artifact");

const args = new Map();
const flags = new Set();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(arg.slice(2), next);
    i += 1;
  } else flags.add(arg.slice(2));
}
const runtime = args.get("runtime") ?? "node";
if (!["node", "bun", "deno"].includes(runtime)) {
  console.error(`unknown runtime "${runtime}" (expected node, bun, or deno)`);
  process.exit(2);
}

const tag = `skein-smoke-${runtime}`;
const network = `skein-smoke-net-${runtime}`;
const appName = `skein-smoke-app-${runtime}`;
const pgName = `skein-smoke-pg-${runtime}`;
const redisName = `skein-smoke-redis-${runtime}`;
const hostPort = { node: 8321, bun: 8322, deno: 8323 }[runtime];
const context = path.join(repoRoot, ".profiles", "image-smoke", runtime);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (file, argv, options = {}) =>
  execFileSync(file, argv, { encoding: "utf8", stdio: "pipe", ...options });
const quiet = (file, argv) => spawnSync(file, argv, { stdio: "ignore" });

const failures = [];
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

/**
 * Vendor every publishable workspace package into `vendor/`, in the form the target runtime's
 * installer can actually consume.
 *
 * **There is no single form that works on all three**, which is itself a finding worth keeping:
 *
 * - **Tarballs** (`npm`, `bun`): the install drops devDependencies and root `overrides` reach inside,
 *   so the packages resolve each other locally. `deno install` instead symlinks `node_modules/skein-js`
 *   *at the .tgz file*, and the container dies with `Not a directory (os error 20)`.
 * - **Extracted directories** (`deno`): a `file:` directory is treated as a link. npm then installs the
 *   link's devDependencies even under `--omit=dev` (404 on the private `@skein-js/test-support`) and
 *   `overrides` do *not* reach into it (404 on the unpublished `@skein-js/fetch`), so each manifest has
 *   to name its siblings itself. Bun does not follow those relative specs at all.
 *
 * `pnpm pack` rewrites `workspace:*` to a concrete version, which is why either form needs the
 * cross-references repaired — left alone they resolve from the registry.
 */
function vendorLocalPackages(vendorDir, form) {
  mkdirSync(vendorDir, { recursive: true });
  const vendored = new Map();

  for (const dir of readdirSync(path.join(repoRoot, "packages"))) {
    const manifestPath = path.join(repoRoot, "packages", dir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (manifest.private) continue;

    const before = new Set(readdirSync(vendorDir));
    run("pnpm", ["pack", "--pack-destination", vendorDir], {
      cwd: path.join(repoRoot, "packages", dir),
    });
    const tarball = readdirSync(vendorDir).find((file) => !before.has(file));
    if (!tarball) throw new Error(`pnpm pack produced nothing for ${manifest.name}`);

    if (form === "tarball") {
      vendored.set(manifest.name, tarball);
      continue;
    }
    const target = path.join(vendorDir, path.basename(tarball, ".tgz"));
    mkdirSync(target, { recursive: true });
    // --strip-components=1 drops the `package/` prefix every npm tarball carries.
    run("tar", ["-xzf", path.join(vendorDir, tarball), "-C", target, "--strip-components=1"]);
    rmSync(path.join(vendorDir, tarball));
    vendored.set(manifest.name, path.basename(target));
  }

  if (form === "directory") {
    for (const dir of vendored.values()) {
      const manifestPath = path.join(vendorDir, dir, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest.devDependencies;
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const deps = manifest[field];
        if (!deps) continue;
        for (const name of Object.keys(deps)) {
          const sibling = vendored.get(name);
          if (sibling) deps[name] = `file:../${sibling}`;
        }
      }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }

  return vendored;
}

function assembleContext() {
  rmSync(context, { recursive: true, force: true });
  mkdirSync(context, { recursive: true });
  for (const entry of ["langgraph.json", "schemas.json", "graphs"]) {
    cpSync(path.join(artifactFixture, entry), path.join(context, entry), { recursive: true });
  }

  // Deno cannot install a local tarball; npm and bun cannot follow the directory form's relative
  // sibling specs. See `vendorLocalPackages`.
  const form = runtime === "deno" ? "directory" : "tarball";
  const vendored = vendorLocalPackages(path.join(context, "vendor"), form);
  const fileSpec = (name) => `file:vendor/${vendored.get(name)}`;
  const testSupport = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/test-support/package.json"), "utf8"),
  );
  // Only the tarball form needs these: it keeps each package's published cross-references, and an
  // override is the only thing that redirects them. The directory form rewrote the manifests instead.
  const overrides =
    form === "tarball"
      ? Object.fromEntries(
          [...vendored.keys()]
            .filter((name) => name !== "skein-js")
            .map((name) => [name, fileSpec(name)]),
        )
      : undefined;

  writeFileSync(
    path.join(context, "package.json"),
    `${JSON.stringify(
      {
        name: "skein-image-smoke",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@langchain/core": testSupport.devDependencies["@langchain/core"],
          "@langchain/langgraph": testSupport.devDependencies["@langchain/langgraph"],
          "skein-js": fileSpec("skein-js"),
        },
        ...(overrides ? { overrides } : {}),
      },
      null,
      2,
    )}\n`,
  );

  const dockerfilePath = path.join(context, "Dockerfile");
  run("node", [
    path.join(repoRoot, "packages/cli/dist/index.js"),
    "dockerfile",
    "-c",
    path.join(context, "langgraph.json"),
    "--runtime",
    runtime,
    "-o",
    dockerfilePath,
  ]);

  // The generated Dockerfile installs from `package.json` alone before copying the artifact, so the
  // pinned deps cache independently of the graphs. That layer ordering is right for the real thing —
  // which installs from a registry — but a `file:` spec has to exist at install time, so the vendor
  // directory is spliced in just ahead of it. This is the ONE way the smoked image differs from a
  // user's; everything else about it is the generated output verbatim.
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const anchor = "COPY package.json ./";
  if (!dockerfile.includes(anchor)) {
    throw new Error(`generated Dockerfile no longer contains "${anchor}" — update this splice`);
  }
  writeFileSync(dockerfilePath, dockerfile.replace(anchor, `${anchor}\nCOPY vendor ./vendor`));
  return vendored;
}

function startBackingServices() {
  quiet("docker", ["network", "create", network]);
  quiet("docker", ["rm", "-f", pgName, redisName]);
  run("docker", [
    "run",
    "-d",
    "--name",
    pgName,
    "--network",
    network,
    "-e",
    "POSTGRES_PASSWORD=skein",
    "-e",
    "POSTGRES_DB=skein",
    "pgvector/pgvector:pg17",
  ]);
  run("docker", ["run", "-d", "--name", redisName, "--network", network, "redis:7-alpine"]);
}

async function waitForPostgres() {
  for (let i = 0; i < 120; i += 1) {
    const probe = spawnSync("docker", ["exec", pgName, "pg_isready", "-U", "postgres"], {
      stdio: "ignore",
    });
    if (probe.status === 0) return;
    await sleep(500);
  }
  throw new Error("Postgres never became ready");
}

async function waitForApp() {
  for (let i = 0; i < 240; i += 1) {
    const state = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", appName], {
      encoding: "utf8",
    });
    if (state.stdout?.trim() === "false") {
      throw new Error(`container exited early:\n${run("docker", ["logs", appName])}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/ok`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`app never became ready:\n${run("docker", ["logs", appName])}`);
}

const api = async (method, route, body) => {
  const response = await fetch(`http://127.0.0.1:${hostPort}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${route} → ${response.status}`);
  return response.json();
};

function cleanup() {
  if (flags.has("keep")) {
    console.log(`\n--keep: left ${appName}, ${pgName}, ${redisName}, and ${context} in place.`);
    return;
  }
  quiet("docker", ["rm", "-f", appName, pgName, redisName]);
  quiet("docker", ["network", "rm", network]);
  rmSync(context, { recursive: true, force: true });
}

async function main() {
  console.log(`\n=== image smoke: ${runtime} ===\n`);

  console.log("assembling a build context from local packages");
  const vendored = assembleContext();
  check(`vendored ${vendored.size} local packages`, vendored.size > 0);

  console.log(`building ${tag} (the graph compatibility probe runs inside this build)`);
  execFileSync("docker", ["build", "--progress=plain", "-t", tag, context], { stdio: "inherit" });
  check("the image builds, including the graph compatibility probe", true);

  if (flags.has("build-only")) {
    // Deno's installer does not recurse into a `file:` dependency's own `file:` dependencies, so a
    // vendored tree boots with `Could not resolve "@skein-js/agent-protocol"`. That is a limitation of
    // substituting *unpublished* packages, not of the generated image — a released `skein-js` installs
    // from the registry, which Deno handles. Until a prerelease exists, Deno's in-container coverage
    // stops at the build (where the `deno eval` permission-flag defect lived) and its run-time
    // behaviour is covered on the host by `runtime-conformance.mjs`.
    console.log(`\n--build-only: skipping the run phase for ${runtime}.`);
    console.log(`\n${checks - failures.length}/${checks} checks passed for the ${runtime} image`);
    if (failures.length > 0) process.exitCode = 1;
    return;
  }

  startBackingServices();
  await waitForPostgres();

  // 512Mi: the small shape docs/performance.md sizes for, and the one where a runtime that never
  // returns memory to the OS shows up as an OOM kill rather than as a slow request.
  quiet("docker", ["rm", "-f", appName]);
  run("docker", [
    "run",
    "-d",
    "--name",
    appName,
    "--network",
    network,
    "--memory=512m",
    "--memory-swap=512m",
    "-p",
    `${hostPort}:8123`,
    "-e",
    `POSTGRES_URI=postgresql://postgres:skein@${pgName}:5432/skein`,
    "-e",
    `REDIS_URI=redis://${redisName}:6379`,
    tag,
  ]);
  await waitForApp();
  check("the image boots and answers /ok", true);

  console.log("one streaming run");
  const thread = await api("POST", "/threads", {});
  const streamResponse = await fetch(
    `http://127.0.0.1:${hostPort}/threads/${thread.thread_id}/runs/stream`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assistant_id: "tokens",
        input: { messages: [{ role: "human", content: "go" }] },
        stream_mode: ["custom"],
      }),
    },
  );
  const body = await streamResponse.text();
  const frames = body.split("\n\n").filter((frame) => frame.includes("event:"));
  // The assertion that caught the Deno permission defect: the run fails *inside* a 200 response, so
  // only the frame contents reveal it.
  check(
    "no error frame in the stream",
    !body.includes("event: error"),
    body.includes("event: error") ? body.slice(body.indexOf("event: error"), 400) : undefined,
  );
  check("frames arrived", frames.length > 1, `got ${frames.length}`);

  console.log("background run + SIGTERM (docker stop)");
  const background = await api("POST", `/threads/${thread.thread_id}/runs`, {
    assistant_id: "tokens",
    input: { messages: [{ role: "human", content: "bg" }] },
  });
  await sleep(1500);
  const stopStartedAt = Date.now();
  run("docker", ["stop", "-t", "30", appName]);
  const stopMs = Date.now() - stopStartedAt;
  // `docker stop` sends SIGTERM and only escalates at -t. Beating that window means the runtime's own
  // signal handling drained rather than the daemon killing it.
  check("stops on SIGTERM well inside the escalation window", stopMs < 25_000, `${stopMs}ms`);
  const exitCode = run("docker", ["inspect", "-f", "{{.State.ExitCode}}", appName]).trim();
  check("exits cleanly", exitCode === "0", `exit ${exitCode}`);

  const status = run("docker", [
    "exec",
    pgName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "skein",
    "-tAc",
    `select status from runs where run_id='${background.run_id}'`,
  ]).trim();
  check(
    "no run is left stranded as `running`",
    ["success", "error", "cancelled", "timeout", "interrupted"].includes(status),
    `status=${status}`,
  );

  console.log(`\n${checks - failures.length}/${checks} checks passed for the ${runtime} image`);
  if (failures.length > 0) {
    console.error(`\n${runtime} image FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`\n${runtime} image smoke error:`, error.message ?? error);
  process.exitCode = 1;
} finally {
  cleanup();
}
