// `skein import-langgraph` — a one-shot, lossless migration of an existing LangGraph.js in-memory
// dev state (`.langgraph_api/`, written by `langgraph dev`) into skein. Two sinks:
//   • memory (default): write skein's `<config>/.skein/dev-state.json`, picked up on the next
//     `skein dev`. (`skein dev` also auto-detects and imports this on first boot; this command is
//     the explicit path — preview counts, re-run, or `--force` overwrite.)
//   • postgres: load into a live Postgres store + checkpointer, for moving an in-memory
//     `langgraph dev` — even one running in production — onto a durable skein deployment.
// The heavy lifting (reading the LangGraph format, mapping to skein's snapshot, copying checkpoints)
// lives in `@skein-js/express`; this is just the CLI wiring + the on-disk / DB sink.

import { existsSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "@skein-js/config";
import {
  describeSnapshot,
  loadSnapshotIntoStore,
  readLanggraphDevState,
  type DevStateCounts,
} from "@skein-js/express";
import { buildRuntime, type StoreDriver } from "@skein-js/runtime";

import { devStateFile, writeDevStateFile, LANGGRAPH_DIR } from "./dev-state.js";
import { applyProjectEnv } from "./project-env.js";
import { createViteGraphLoader } from "./vite-graph-loader.js";

/** The flags `skein import-langgraph` accepts, after commander parsing. */
export interface ImportLanggraphOptions {
  config: string;
  /** Import target: `"memory"` (write `.skein/dev-state.json`) or `"postgres"` (`POSTGRES_URI`). */
  store: StoreDriver;
  /** Source directory; defaults to `<configDir>/.langgraph_api`. */
  from?: string;
  /** Overwrite an existing `.skein/dev-state.json` (memory sink only). */
  force: boolean;
}

function summarize(counts: DevStateCounts): string {
  return (
    `${counts.assistants} assistant(s), ${counts.threads} thread(s), ${counts.runs} run(s), ` +
    `${counts.items} store item(s), checkpoint history for ${counts.checkpointedThreads} thread(s)`
  );
}

export async function runImportLanggraph(options: ImportLanggraphOptions): Promise<void> {
  const configPath = path.resolve(process.cwd(), options.config);
  const { config, configDir } = await loadConfig({ configPath });

  const sourceDir = options.from
    ? path.resolve(process.cwd(), options.from)
    : path.join(configDir, LANGGRAPH_DIR);

  const snapshot = await readLanggraphDevState(sourceDir);
  if (snapshot === null) {
    console.log(`skein: no LangGraph dev state found at ${sourceDir}; nothing to import.`);
    return;
  }
  const counts = describeSnapshot(snapshot);

  if (options.store === "memory") {
    const stateFile = devStateFile(configDir);
    if (existsSync(stateFile) && !options.force) {
      console.error(
        `skein: ${path.relative(process.cwd(), stateFile)} already exists. ` +
          `Re-run with --force to overwrite it (or delete it first).`,
      );
      process.exitCode = 1;
      return;
    }
    writeDevStateFile(stateFile, JSON.stringify(snapshot));
    console.log(
      `skein: imported ${summarize(counts)} → ${path.relative(process.cwd(), stateFile)}.`,
    );
    console.log("skein: run `skein dev` to use it.");
    return;
  }

  // Postgres sink. Resolve env first (so POSTGRES_URI is set before buildRuntime), then build the
  // Postgres runtime. buildRuntime eagerly loads the project's auth module (and any custom embed),
  // so it needs the same vite-backed importer `skein dev` uses — otherwise a TypeScript auth/embed
  // module fails to import under plain Node. The loader is closed once the import completes.
  await applyProjectEnv(config, configDir);
  const loader = await createViteGraphLoader(configDir);
  try {
    const runtime = await buildRuntime({
      configPath,
      importModule: loader.importModule,
      store: "postgres",
      queue: "memory",
    });
    try {
      await loadSnapshotIntoStore(snapshot, runtime.deps.store, runtime.deps.checkpointer);
    } finally {
      await runtime.dispose();
    }
  } finally {
    await loader.close();
  }
  console.log(`skein: imported ${summarize(counts)} into Postgres.`);
}
