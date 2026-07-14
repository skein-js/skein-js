// `skein dev` — the in-process development server, a drop-in for `langgraph dev`. Everything runs
// in this single Node process: vite transforms + watches the project's TypeScript graphs (see
// vite-graph-loader.ts), and `@skein-js/express` serves the Agent Protocol over the runtime built
// by `@skein-js/runtime` — in-memory by default, or `--store postgres` / `--queue redis` to develop
// against production-shaped storage without Docker. Two things go beyond a naive dev server:
//   • Hot reload keeps state — on a source change we clear vite's cache and swap in the fresh graph
//     code, but reuse the same store/checkpointer, so threads, runs, and memories survive the reload.
//   • Persistence across restarts — dev state is snapshotted to `<project>/.skein/` and restored on
//     the next boot (mirroring how `langgraph dev` keeps local state).
// No Docker, no child process.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadConfig, parseEnvFile, resolveEnv } from "@skein-js/config";
import {
  createExpressServer,
  type DevStateSnapshot,
  type SkeinExpressServer,
} from "@skein-js/express";
import { buildRuntime, type QueueDriver, type StoreDriver } from "@skein-js/runtime";

import { createViteGraphLoader } from "./vite-graph-loader.js";

/** The flags `skein dev` accepts, after commander parsing. */
export interface DevCommandOptions {
  config: string;
  port: number;
  host: string;
  /** `false` when `--no-reload` was passed. */
  reload: boolean;
  /** `false` when `--no-persist` was passed. */
  persist: boolean;
  /** Protocol-resource + checkpoint store: `"memory"` (default) or `"postgres"` (`DATABASE_URL`). */
  store: StoreDriver;
  /** Run queue + stream bus: `"memory"` (default) or `"redis"` (`REDIS_URL`). */
  queue: QueueDriver;
}

/** Wait this long after the last change event before reloading, so a burst of saves is one reload. */
const RELOAD_DEBOUNCE_MS = 120;
/** How often to autosave dev state to disk while running. */
const AUTOSAVE_MS = 2000;
/** How long to wait for a graceful shutdown before forcing exit — an in-flight run can stall it. */
const FORCE_EXIT_MS = 5000;
/** Where persisted dev state lives, relative to the config directory. */
const STATE_DIR = ".skein";
const STATE_FILE = "dev-state.json";

/** Console logger for the dev server — drives per-request logging and surfaces engine warnings. */
const devLogger = {
  debug: (message: string) => console.debug(message),
  info: (message: string) => console.log(message),
  warn: (message: string, meta?: unknown) =>
    meta === undefined ? console.warn(message) : console.warn(message, meta),
  error: (message: string, meta?: unknown) =>
    meta === undefined ? console.error(message) : console.error(message, meta),
};

/** Apply resolved env to `process.env` without clobbering values already set in the environment. */
function applyEnv(resolved: Record<string, string>): void {
  for (const [key, value] of Object.entries(resolved)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Parse a conventional `.env` in `dir`, if present. Best-effort — a read/parse error yields `{}`. */
function readConventionalDotEnv(dir: string): Record<string, string> {
  const envPath = path.join(dir, ".env");
  if (!existsSync(envPath)) return {};
  try {
    return parseEnvFile(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

export async function runDev(options: DevCommandOptions): Promise<void> {
  const configPath = path.resolve(process.cwd(), options.config);

  // Validate + resolve env before starting anything, so a bad config fails fast and graphs see
  // their env on first load. `loadConfig` here does not import `.ts` — that happens through vite.
  const { config, configDir } = await loadConfig({ configPath });
  // A conventional `.env` is the base; `langgraph.json`'s declared `env` overrides it; the ambient
  // environment wins over both (dotenv convention). Skip the conventional read when the declared
  // `env` already points at the same `.env` file, so we don't read + parse it twice.
  const declaredEnvPath =
    typeof config.env === "string" ? path.resolve(configDir, config.env) : undefined;
  const conventional =
    declaredEnvPath === path.join(configDir, ".env") ? {} : readConventionalDotEnv(configDir);
  applyEnv({ ...conventional, ...(await resolveEnv(config, configDir)) });
  if (declaredEnvPath !== undefined && !existsSync(declaredEnvPath)) {
    console.warn(`skein: env file "${config.env}" not found; continuing without it.`);
  }

  const stateDir = path.join(configDir, STATE_DIR);
  const stateFile = path.join(stateDir, STATE_FILE);

  // Ignore our own persisted-state dir: its periodic autosave writes would otherwise be seen as
  // source changes and trigger an endless reload loop.
  const loader = await createViteGraphLoader(configDir, [`${STATE_DIR}/**`, `**/${STATE_DIR}/**`]);
  const runtime = await buildRuntime({
    configPath,
    importModule: loader.importModule,
    store: options.store,
    queue: options.queue,
  });
  const { port, host } = options;
  // On-disk snapshotting only applies to the all-memory runtime; durable drivers persist inherently.
  const canPersist = options.persist && runtime.snapshotState !== undefined;
  if (options.persist && runtime.snapshotState === undefined) {
    console.log(
      `skein: state persists in ${options.store}/${options.queue}; skipping .skein snapshot.`,
    );
  }
  if (canPersist && existsSync(stateFile)) {
    try {
      runtime.hydrateState?.(JSON.parse(readFileSync(stateFile, "utf8")) as DevStateSnapshot);
      console.log("skein: restored dev state.");
    } catch (error) {
      console.warn(
        `skein: could not restore dev state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let server: SkeinExpressServer;
  try {
    server = await createExpressServer({
      deps: runtime.deps,
      cors: runtime.cors,
      warm: true,
      logger: devLogger,
    });
    await server.listen(port, host);
  } catch (error) {
    // `skeinRouter` starts the run worker before `listen`; without these closes a bind failure
    // leaves the worker holding the event loop open and the process hangs instead of exiting.
    await Promise.allSettled([loader.close(), runtime.dispose()]);
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === "EADDRINUSE"
        ? `skein: port ${port} is already in use. Stop the other process or pass --port.`
        : `skein: failed to start dev server: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`skein-js listening on http://${host}:${port}`);

  let lastSaved: string | undefined;
  const saveState = () => {
    if (!canPersist || runtime.snapshotState === undefined) return;
    try {
      const serialized = JSON.stringify(runtime.snapshotState());
      if (serialized === lastSaved) return; // unchanged since the last write — skip the disk churn
      mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      writeFileSync(tmp, serialized);
      renameSync(tmp, stateFile); // atomic replace, so a crash mid-write can't corrupt the file
      lastSaved = serialized;
    } catch (error) {
      console.warn(
        `skein: could not persist dev state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  let autosave: NodeJS.Timeout | undefined;
  if (canPersist) {
    autosave = setInterval(saveState, AUTOSAVE_MS);
    autosave.unref();
  }

  if (options.reload) {
    let reloading = false;
    let dirty = false;
    let pending: NodeJS.Timeout | undefined;
    const reload = async () => {
      // If a reload is already running, remember that more changes arrived and re-run once it's done,
      // so edits saved mid-reload are never dropped.
      if (reloading) {
        dirty = true;
        return;
      }
      reloading = true;
      try {
        console.log("skein: change detected, reloading…");
        loader.clearCache();
        await runtime.reloadGraphs();
        // Re-import graphs: surfaces errors now and re-arms vite's watcher on the fresh module graph.
        await Promise.all(
          runtime.deps.graphs.ids.map((id) =>
            runtime.deps.graphs.load(id).catch((error: unknown) => {
              console.error(`skein: graph "${id}" failed to load: ${String(error)}`);
            }),
          ),
        );
        console.log("skein: reloaded.");
      } catch (error) {
        // A bad config (e.g. langgraph.json edited to invalid JSON) rejects reloadGraphs. Log and
        // keep the watcher alive — never let it become an unhandled rejection that kills the server.
        console.error(
          `skein: reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        reloading = false;
        if (dirty) {
          dirty = false;
          void reload();
        }
      }
    };
    loader.watcher.on("change", (file) => {
      // Defense in depth against a self-triggered loop: never reload on our own state writes.
      if (`${path.resolve(file)}${path.sep}`.startsWith(`${stateDir}${path.sep}`)) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
    });
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (autosave) clearInterval(autosave);
    const forceExit = setTimeout(() => process.exit(0), FORCE_EXIT_MS);
    forceExit.unref();
    saveState();
    void Promise.allSettled([server.close(), loader.close(), runtime.dispose()]).then(() =>
      process.exit(0),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
