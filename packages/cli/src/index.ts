#!/usr/bin/env node
// skein — a drop-in replacement for the LangGraph CLI (dev/up/build/dockerfile).
// See docs/langgraph-cli-compat.md for the command surface we mirror.
//
// This is the framework skeleton: commander wires the command surface and shared flags;
// the action handlers are implemented in Phase 1 (see docs/roadmap.md).

import { createRequire } from "node:module";

import { Command, InvalidArgumentError } from "@commander-js/extra-typings";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/** Thrown by a command whose behavior has not been implemented yet. */
class NotImplementedError extends Error {
  constructor(command: string) {
    super(`\`skein ${command}\` is not implemented yet (Phase 1). See docs/roadmap.md.`);
    this.name = "NotImplementedError";
  }
}

/** Parse a `--port` value into a valid port number, rejecting anything else. */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError("Port must be an integer between 0 and 65535.");
  }
  return port;
}

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
  .option("-p, --port <port>", "Port to bind", parsePort, 2024)
  .option("--host <host>", "Host to bind", "localhost")
  .option("--no-reload", "Disable hot reload")
  .action(() => {
    throw new NotImplementedError("dev");
  });

program
  .command("up")
  .description("Bring up the production stack (Docker Compose: app + Postgres + Redis).")
  .option("-c, --config <path>", "Path to langgraph.json", "langgraph.json")
  .option("-p, --port <port>", "Port to expose", parsePort, 8123)
  .option("--host <host>", "Host to bind", "0.0.0.0")
  .action(() => {
    throw new NotImplementedError("up");
  });

program
  .command("build")
  .description("Build a deployable Docker image from the config.")
  .option("-c, --config <path>", "Path to langgraph.json", "langgraph.json")
  .action(() => {
    throw new NotImplementedError("build");
  });

program
  .command("dockerfile")
  .description("Emit a standalone Dockerfile from the config.")
  .option("-c, --config <path>", "Path to langgraph.json", "langgraph.json")
  .action(() => {
    throw new NotImplementedError("dockerfile");
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  program.error(error instanceof Error ? error.message : String(error));
}
