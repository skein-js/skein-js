#!/usr/bin/env node
// skein — a drop-in replacement for the LangGraph CLI (dev/up/build/dockerfile).
// See docs/langgraph-cli-compat.md for the command surface we mirror.
//
// This is the framework skeleton: commander wires the command surface and shared flags;
// the action handlers are implemented in Phase 1 (see docs/roadmap.md).

import { createRequire } from "node:module";

import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import type { SkeinRuntimeName } from "@skein-js/config";

import { runDev } from "./dev-command.js";
import { runBuild, runDockerfile, runUp } from "./docker/commands.js";
import { parseQueue, parseStartQueue, parseStartStore, parseStore } from "./driver-flags.js";
import { runImportLanggraph } from "./import-command.js";
import { DEFAULT_CONTAINER_PORT, DEFAULT_DEV_PORT } from "./serve-env.js";
import { runStart } from "./start-command.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/** Parse a `--port` value into a valid port number, rejecting anything else. */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError("Port must be an integer between 0 and 65535.");
  }
  return port;
}

/** Parse a positive-integer flag, naming the setting so the rejection says which one was wrong. */
function parsePositiveInt(label: string) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`${label} must be a positive integer.`);
    }
    return parsed;
  };
}

const parseConcurrency = parsePositiveInt("Concurrency");
const parseRunTimeout = parsePositiveInt("Run timeout");

function parseRuntime(value: string): SkeinRuntimeName {
  if (value === "node" || value === "bun" || value === "deno") return value;
  throw new InvalidArgumentError("Runtime must be one of: node, bun, deno.");
}

/** Build a commander parser that accepts only one of `choices`, rejecting anything else. */
const program = new Command()
  .name("skein")
  .description(
    "Agent Protocol server for LangGraph.js — a drop-in replacement for the LangGraph CLI.",
  )
  .version(version, "-v, --version");

program
  .command("dev")
  .description("Run the in-process dev server with hot reload (no Docker).")
  .option("-c, --config <path>", "Path to langgraph.json", "langgraph.json")
  // The default binds 2024, but when `--port` is not passed, runDev falls back to a `PORT` env var
  // (Railway/Fly/Render/Heroku inject one) — resolved there, after the project's `.env` is merged.
  .option("-p, --port <port>", "Port to bind", parsePort, DEFAULT_DEV_PORT)
  // Bind IPv4 explicitly: "localhost" can resolve to `::1`, which trips IPv4-only SDK clients.
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--no-reload", "Disable hot reload")
  .option("--no-persist", "Don't persist dev state to .skein/ between restarts")
  // Develop against production-shaped storage without Docker (needs POSTGRES_URI / REDIS_URI).
  .option("--store <driver>", "Store driver: memory | postgres", parseStore, "memory")
  .option("--queue <driver>", "Queue driver: memory | redis", parseQueue, "memory")
  // Deliberately no commander default: an unset flag stays `undefined`, which is what lets runDev
  // fall through to SKEIN_RUN_CONCURRENCY / N_JOBS_PER_WORKER. That is also why this needs none of
  // the `getOptionValueSource(...) === "cli"` machinery --port/--host require for their defaults.
  .option(
    "--concurrency <count>",
    "Queued runs the background worker executes at once (default 10; env SKEIN_RUN_CONCURRENCY)",
    parseConcurrency,
  )
  // The LangGraph CLI's spelling and short flag for the same knob, so an existing `langgraph dev -n 4`
  // command line moves over unchanged. `--concurrency` wins if both are passed.
  .option(
    "-n, --n-jobs-per-worker <count>",
    "Alias for --concurrency (LangGraph CLI compatibility)",
    parseConcurrency,
  )
  // Served by default: a dev server is exactly where you want to see your threads and runs, and a
  // console you have to opt into is one most people never find. `skein start` is the reverse — there
  // it takes an `http.console` block in langgraph.json. See docs/console.md.
  .option("--no-console", "Don't serve the skein console at /console")
  .option("-v, --verbose", "Log per-run activity: start/finish, tool calls, and interrupts")
  // On by default here, off by default under `start` — see `request-log.ts`. No commander
  // default so an unset flag stays `undefined` and the env var gets a look in.
  .option("--request-log", "Log a line per HTTP request (default on; env SKEIN_REQUEST_LOG)")
  .option("--no-request-log", "Don't log a line per HTTP request")
  .option(
    "--run-timeout <ms>",
    "Abort a run that executes for longer than this (default off; env SKEIN_RUN_TIMEOUT_MS)",
    parseRunTimeout,
  )
  // Pass whether --port/--host came from the CLI so runDev only applies the PORT/HOST env fallback
  // when the user left them at their defaults (an explicit flag always wins over the env).
  .action((options, command) =>
    runDev({
      ...options,
      portExplicit: command.getOptionValueSource("port") === "cli",
      hostExplicit: command.getOptionValueSource("host") === "cli",
    }),
  );

program
  .command("start")
  .description("Serve a pre-built .skein/build artifact (the production image entrypoint).")
  .option("-c, --config <path>", "Path to the artifact's langgraph.json", "langgraph.json")
  // Defaults to the container port, not `dev`'s 2024: this is the production image's entrypoint, and
  // the fallback has to match what the Dockerfile EXPOSEs and health-checks so a bare `docker run`
  // (or a platform that makes you declare the port — App Runner, ECS, k8s) lands on the right one.
  // An unset flag still falls back to a PORT env var first (Railway/Fly/Render/Cloud Run inject one),
  // resolved after the config's inline env is merged.
  .option("-p, --port <port>", "Port to bind", parsePort, DEFAULT_CONTAINER_PORT)
  .option("--host <host>", "Host to bind", "127.0.0.1")
  // Durable-only, and defaulted so a bare `skein start` reaches for them. `@skein-js/runtime`'s
  // `requireEnv` then fails with an actionable error when POSTGRES_URI / REDIS_URI is missing, so the
  // hard requirement mostly falls out of the defaults — the restricted parsers close the rest.
  .option("--store <driver>", "Store driver: postgres", parseStartStore, "postgres")
  .option("--queue <driver>", "Queue driver: redis", parseStartQueue, "redis")
  .option("--runtime <runtime>", "Production runtime: node | bun | deno", parseRuntime)
  .option("--runtime-version <version>", "Override the configured runtime version")
  // Same pair as `dev` — see the note there on why neither carries a commander default.
  .option(
    "--concurrency <count>",
    "Queued runs the background worker executes at once (default 10; env SKEIN_RUN_CONCURRENCY)",
    parseConcurrency,
  )
  .option(
    "-n, --n-jobs-per-worker <count>",
    "Alias for --concurrency (LangGraph CLI compatibility)",
    parseConcurrency,
  )
  .option("-v, --verbose", "Log per-run activity: start/finish, tool calls, and interrupts")
  .option("--request-log", "Log a line per HTTP request (default off; env SKEIN_REQUEST_LOG)")
  .option(
    "--run-timeout <ms>",
    "Abort a run that executes for longer than this (default off; env SKEIN_RUN_TIMEOUT_MS)",
    parseRunTimeout,
  )
  .action((options, command) =>
    runStart({
      ...options,
      portExplicit: command.getOptionValueSource("port") === "cli",
      hostExplicit: command.getOptionValueSource("host") === "cli",
    }),
  );

program
  .command("up")
  .description("Bring up the production stack (Docker Compose: app + Postgres + Redis).")
  .option("-c, --config <path>", "Path to langgraph.json", "langgraph.json")
  .option("-p, --port <port>", "Port to expose", parsePort, DEFAULT_CONTAINER_PORT)
  .option("--host <host>", "Host to bind", "0.0.0.0")
  .option("--runtime <runtime>", "Production runtime: node | bun | deno", parseRuntime)
  .option("--runtime-version <version>", "Override the configured runtime version")
  .option(
    "-n, --npmrc <path>",
    "Path to an .npmrc for authenticating private-registry installs (wired in as a build secret)",
  )
  .action((options) => runUp(options));

program
  .command("build")
  .description("Build a deployable Docker image from the config.")
  .option("-c, --config <path>", "Path to langgraph.json", "langgraph.json")
  .option("-t, --tag <tag>", "Image tag (defaults to the project directory name)")
  .option("--runtime <runtime>", "Production runtime: node | bun | deno", parseRuntime)
  .option("--runtime-version <version>", "Override the configured runtime version")
  .option(
    "-n, --npmrc <path>",
    "Path to an .npmrc for authenticating private-registry installs (passed to docker build as a BuildKit secret)",
  )
  .option(
    "--artifact-only",
    "Write .skein/build (artifact + Dockerfile) and stop, without invoking Docker",
    false,
  )
  .action((options) => runBuild(options));

program
  .command("dockerfile")
  .description("Emit a standalone Dockerfile from the config.")
  .option("-c, --config <path>", "Path to langgraph.json", "langgraph.json")
  .option("-o, --output <path>", "Write the Dockerfile here instead of stdout")
  .option("--runtime <runtime>", "Production runtime: node | bun | deno", parseRuntime)
  .option("--runtime-version <version>", "Override the configured runtime version")
  .action((options) => runDockerfile(options));

program
  .command("import-langgraph")
  .description("Import an existing LangGraph in-memory dev state (.langgraph_api/) into skein.")
  .option("-c, --config <path>", "Path to langgraph.json", "langgraph.json")
  .option(
    "--store <driver>",
    "Import target: memory (.skein/dev-state.json) | postgres (POSTGRES_URI)",
    parseStore,
    "memory",
  )
  .option("--from <dir>", "Source .langgraph_api directory (defaults to alongside langgraph.json)")
  .option("--force", "Overwrite an existing .skein/dev-state.json (memory target)", false)
  .action((options) => runImportLanggraph(options));

try {
  await program.parseAsync(process.argv);
} catch (error) {
  program.error(error instanceof Error ? error.message : String(error));
}
