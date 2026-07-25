#!/usr/bin/env node
// skein — a drop-in replacement for the LangGraph CLI (dev/up/build/dockerfile).
// See docs/langgraph-cli-compat.md for the command surface we mirror.
//
// This is the framework skeleton: commander wires the command surface and shared flags;
// the action handlers are implemented in Phase 1 (see docs/roadmap.md).

import { createRequire } from "node:module";

import { Command, InvalidArgumentError } from "@commander-js/extra-typings";

import { runDev } from "./dev-command.js";
import { runBuild, runDockerfile, runUp } from "./docker/commands.js";
import { runImportLanggraph } from "./import-command.js";
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

/** Parse a `--concurrency` value into a positive integer, rejecting anything else. */
function parseConcurrency(value: string): number {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new InvalidArgumentError("Concurrency must be a positive integer.");
  }
  return concurrency;
}

/** Build a commander parser that accepts only one of `choices`, rejecting anything else. */
function parseChoice<const T extends string>(choices: readonly T[]) {
  return (value: string): T => {
    if (!(choices as readonly string[]).includes(value)) {
      throw new InvalidArgumentError(`Must be one of: ${choices.join(", ")}.`);
    }
    return value as T;
  };
}

const parseStore = parseChoice(["memory", "postgres"] as const);
const parseQueue = parseChoice(["memory", "redis"] as const);

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
  .option("-p, --port <port>", "Port to bind", parsePort, 2024)
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
  .option("-v, --verbose", "Log per-run activity: start/finish, tool calls, and interrupts")
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
  // No --port default of 2024 here: like `skein dev`, an unset flag falls back to a PORT env var
  // (Railway/Fly/Render inject one), resolved after the config's inline env is merged.
  .option("-p, --port <port>", "Port to bind", parsePort, 2024)
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--store <driver>", "Store driver: memory | postgres", parseStore, "memory")
  .option("--queue <driver>", "Queue driver: memory | redis", parseQueue, "memory")
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
  .option("-p, --port <port>", "Port to expose", parsePort, 8123)
  .option("--host <host>", "Host to bind", "0.0.0.0")
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
  .option(
    "-n, --npmrc <path>",
    "Path to an .npmrc for authenticating private-registry installs (passed to docker build as a BuildKit secret)",
  )
  .action((options) => runBuild(options));

program
  .command("dockerfile")
  .description("Emit a standalone Dockerfile from the config.")
  .option("-c, --config <path>", "Path to langgraph.json", "langgraph.json")
  .option("-o, --output <path>", "Write the Dockerfile here instead of stdout")
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
