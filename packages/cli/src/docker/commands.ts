// `skein up` / `build` / `dockerfile` — the Docker half of the LangGraph CLI surface. They share a
// config front-half (read `langgraph.json` for node_version / dockerfile_lines) and generate the
// Dockerfile + compose from the templates here, then shell out to the `docker` CLI.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { loadConfig, type LanggraphJson } from "@skein-js/config";
import { describeError } from "@skein-js/server-kit";

import { bundleProject } from "../bundle/bundle-project.js";
import { DEFAULT_CONTAINER_PORT } from "../serve-env.js";

import { generateCompose } from "./compose.js";
import { generateDockerfile, generateDockerignore } from "./dockerfile.js";

/**
 * The CLI's own version, pinned as `skein-js` in the generated artifact package.json. Resolved
 * lazily (not at module load) relative to the bundled entry (`dist/index.js` → `../package.json`),
 * matching how index.ts reads it.
 */
function skeinCliVersion(): string {
  return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
}

/** The build artifact dir, relative to the config dir — the self-contained docker build context. */
const ARTIFACT_SUBDIR = path.join(".skein", "build");

/**
 * Port the server binds inside the container (compose maps the host port onto this). Shared with
 * `skein start`'s `--port` default so the EXPOSE, the HEALTHCHECK, compose's mapping and the port the
 * server actually falls back to cannot drift apart.
 */
const CONTAINER_PORT = DEFAULT_CONTAINER_PORT;
const DOCKERFILE_NAME = "Dockerfile";
const COMPOSE_NAME = "compose.yaml";
const DOCKERIGNORE_NAME = ".dockerignore";

interface ConfigContext {
  config: LanggraphJson;
  configDir: string;
  configPath: string;
}

/** Load + validate `langgraph.json`, resolving its path relative to the cwd. */
async function loadConfigContext(configOption: string): Promise<ConfigContext> {
  const configPath = path.resolve(process.cwd(), configOption);
  const { config, configDir } = await loadConfig({ configPath });
  return { config, configDir, configPath };
}

/**
 * Bundle the project into its `.skein/build` artifact dir and write the Docker assets there, returning
 * the artifact dir. This is the self-contained `docker build` context: bundled JS graphs, a production
 * `langgraph.json`, baked `schemas.json`, and a pinned `package.json`, plus the Dockerfile/.dockerignore
 * (and compose for `up`). Bundling runs `emptyOutDir`, so write the Docker assets AFTER it.
 */
async function prepareArtifact(
  context: ConfigContext,
  extraAssets: Array<{ name: string; contents: string }> = [],
): Promise<string> {
  const outDir = path.join(context.configDir, ARTIFACT_SUBDIR);
  console.log("skein: bundling graphs into a production artifact…");
  await bundleProject({
    configPath: context.configPath,
    outDir,
    nodeVersion: context.config.node_version,
    skeinVersion: skeinCliVersion(),
  });
  writeFileSync(path.join(outDir, DOCKERFILE_NAME), renderDockerfile(context, CONTAINER_PORT));
  writeFileSync(path.join(outDir, DOCKERIGNORE_NAME), generateDockerignore());
  for (const asset of extraAssets) writeFileSync(path.join(outDir, asset.name), asset.contents);
  console.log(`skein: wrote artifact to ${path.relative(process.cwd(), outDir) || "."}.`);
  return outDir;
}

/** Render the Dockerfile for a loaded config. */
function renderDockerfile({ config }: ConfigContext, port: number): string {
  return generateDockerfile({
    nodeVersion: config.node_version,
    dockerfileLines: config.dockerfile_lines,
    port,
  });
}

/** A lowercase, docker-safe image name derived from the project directory. */
function defaultImageTag(configDir: string): string {
  const base = path
    .basename(configDir)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  const trimmed = base.replace(/^[-.]+|[-.]+$/g, "");
  return trimmed.length > 0 ? trimmed : "skein-app";
}

/**
 * Resolve `--npmrc` to the absolute path for a BuildKit secret mount, authenticating the image's
 * private-registry install. Returns the absolute path when a readable file is given, `undefined` when
 * the flag is absent (public-registry build — the Dockerfile's secret mount is then inert), and `null`
 * when the given path does not exist (a clear error is printed and `exitCode` set — the caller aborts
 * before invoking docker).
 */
function resolveNpmrcSecret(npmrc: string | undefined): string | null | undefined {
  if (npmrc === undefined) return undefined;
  const resolved = path.resolve(process.cwd(), npmrc);
  if (!existsSync(resolved)) {
    console.error(`skein: --npmrc file not found: ${resolved}`);
    process.exitCode = 1;
    return null;
  }
  return resolved;
}

/** True when the `docker` CLI is on PATH — a fast preflight so we fail with a clear message. */
function dockerAvailable(): boolean {
  const probe = spawnSync("docker", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

function requireDocker(): boolean {
  if (dockerAvailable()) return true;
  console.error("skein: the `docker` CLI was not found on PATH. Install Docker and try again.");
  process.exitCode = 1;
  return false;
}

/** How a spawned process ended: a numeric exit `code`, or a `signal` when it was terminated. */
interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Spawn a command with inherited stdio; resolves once it exits (never rejects). */
function runToCompletion(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`skein: failed to run \`${command}\`: ${error.message}`);
      resolve({ code: null, signal: null });
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** A process succeeded only if it exited 0 on its own (not via a signal). */
function succeeded(result: ProcessResult): boolean {
  return result.code === 0 && result.signal === null;
}

/** Ctrl-C / termination — the normal way to stop a long-running `docker compose up`. */
function wasInterrupted(result: ProcessResult): boolean {
  return result.code === 130 || result.signal === "SIGINT" || result.signal === "SIGTERM";
}

/** Human-readable exit description for error messages. */
function describeExit(result: ProcessResult): string {
  return result.signal !== null ? `killed by ${result.signal}` : `exit ${result.code}`;
}

export interface DockerfileCommandOptions {
  config: string;
  /** Write to this path instead of stdout. */
  output?: string;
}

/** `skein dockerfile` — emit the generated Dockerfile to stdout (or `--output`). */
export async function runDockerfile(options: DockerfileCommandOptions): Promise<void> {
  const context = await loadConfigContext(options.config);
  const contents = renderDockerfile(context, CONTAINER_PORT);
  // The emitted Dockerfile builds against a `.skein/build` artifact (bundled JS + pinned package.json
  // + schemas.json), not the project root — building it by hand won't work. `skein build` is the path
  // that produces the artifact and builds this Dockerfile against it; this command is for inspection.
  console.error(
    "skein: this Dockerfile builds against a `.skein/build` artifact (run `skein build`), " +
      "not the project root.",
  );
  if (options.output !== undefined) {
    const target = path.resolve(process.cwd(), options.output);
    writeFileSync(target, contents);
    console.log(`skein: wrote ${target}.`);
    return;
  }
  process.stdout.write(contents);
}

export interface BuildCommandOptions {
  config: string;
  /** Image tag; defaults to the project directory name. */
  tag?: string;
  /** Path to an `.npmrc`, mounted as a BuildKit secret to authenticate private-registry installs. */
  npmrc?: string;
}

/** `skein build` — bundle the project into a self-contained artifact and build the image from it. */
export async function runBuild(options: BuildCommandOptions): Promise<void> {
  const context = await loadConfigContext(options.config);
  const npmrcPath = resolveNpmrcSecret(options.npmrc);
  if (npmrcPath === null) return;
  if (!requireDocker()) return;

  let artifactDir: string;
  try {
    artifactDir = await prepareArtifact(context);
  } catch (error) {
    console.error(`skein: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }

  const tag = options.tag ?? defaultImageTag(context.configDir);
  const secretArgs = npmrcPath !== undefined ? ["--secret", `id=npmrc,src=${npmrcPath}`] : [];
  console.log(`skein: building image "${tag}"…`);
  const result = await runToCompletion(
    "docker",
    ["build", "-t", tag, "-f", path.join(artifactDir, DOCKERFILE_NAME), ...secretArgs, "."],
    artifactDir,
  );
  if (!succeeded(result)) {
    console.error(`skein: docker build failed (${describeExit(result)}).`);
    process.exitCode = 1;
    return;
  }
  console.log(`skein: built image "${tag}".`);
}

export interface UpCommandOptions {
  config: string;
  port: number;
  host: string;
  /** Path to an `.npmrc`, wired into compose as a build secret for private-registry installs. */
  npmrc?: string;
}

/** `skein up` — bundle into an artifact, then bring up app (built from it) + Postgres + Redis. */
export async function runUp(options: UpCommandOptions): Promise<void> {
  const context = await loadConfigContext(options.config);
  const npmrcPath = resolveNpmrcSecret(options.npmrc);
  if (npmrcPath === null) return;
  if (!requireDocker()) return;

  let artifactDir: string;
  try {
    artifactDir = await prepareArtifact(context, [
      {
        name: COMPOSE_NAME,
        contents: generateCompose({
          hostPort: options.port,
          host: options.host,
          containerPort: CONTAINER_PORT,
          npmrcPath,
        }),
      },
    ]);
  } catch (error) {
    console.error(`skein: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `skein: bringing up the stack (app + Postgres + Redis) on http://${options.host}:${options.port}…`,
  );
  const result = await runToCompletion(
    "docker",
    ["compose", "-f", COMPOSE_NAME, "up", "--build"],
    artifactDir,
  );
  // Ctrl-C is the normal way to stop `compose up`, so only a genuine non-zero exit is an error.
  if (!succeeded(result) && !wasInterrupted(result)) {
    console.error(`skein: docker compose up failed (${describeExit(result)}).`);
    process.exitCode = 1;
  }
}
