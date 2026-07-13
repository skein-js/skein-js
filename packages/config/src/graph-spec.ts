// `path:export` graph resolution — the exact notation LangGraph users already write, so
// moving a project onto Skein needs no code change (docs/langgraph-cli-compat.md). LangGraph's
// own `resolveGraph` lives in `@langchain/langgraph-api`'s graph loader, which is NOT a public
// export, so we mirror its algorithm here exactly: split on the FIRST colon, fall back to the
// `default` export, compile an uncompiled graph, and unwrap the `createAgent` wrapper. The
// `GraphSpec` shape is reused from langgraph-api so `getStaticGraphSchema` accepts our spec.

import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CompiledGraph } from "@langchain/langgraph";
import type { GraphSpec } from "@langchain/langgraph-api/schema";

import { SkeinConfigError } from "./errors.js";

export type { GraphSpec };

/** A factory export: called (optionally with config) to produce a compiled graph. */
export type CompiledGraphFactory = (config: {
  configurable?: Record<string, unknown>;
}) => CompiledGraph<string> | Promise<CompiledGraph<string>>;

/** A resolved graph: either a compiled graph or a factory that produces one per config. */
export type ResolvedGraph = CompiledGraph<string> | CompiledGraphFactory;

/**
 * Parse `"path:export"` into an absolute {@link GraphSpec}, resolving the path against
 * `baseDir`. Mirrors LangGraph's `spec.split(":", 2)` + `exportSymbol || "default"`, so
 * `"./src/agent.ts:graph"` → `{ sourceFile: "<baseDir>/src/agent.ts", exportSymbol: "graph" }`
 * and a colon-less `"./src/agent.ts"` resolves to that module's default export.
 */
export function parseGraphSpec(spec: string, baseDir: string): GraphSpec {
  const [userFile, exportSymbol] = spec.split(":", 2);
  if (!userFile) {
    throw new SkeinConfigError(`Invalid graph spec "${spec}" — expected "path:export".`);
  }
  return {
    sourceFile: path.resolve(baseDir, userFile),
    exportSymbol: exportSymbol || "default",
  };
}

/** An uncompiled graph builder — an object exposing a `compile()` method. */
function isUncompiledBuilder(value: unknown): value is { compile: () => CompiledGraph<string> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "compile" in value &&
    typeof (value as { compile: unknown }).compile === "function"
  );
}

/** A compiled graph — an object exposing its source `builder`. */
function isCompiledGraphLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "builder" in value &&
    typeof (value as { builder: unknown }).builder === "object" &&
    (value as { builder: unknown }).builder !== null
  );
}

/**
 * Turn an export (or a factory's result) into a compiled graph: compile it if it's an
 * uncompiled builder, then unwrap the `createAgent` wrapper (which looks compiled but exposes
 * the real pregel under `.graph`). Mirrors langgraph-api's `resolveGraph` `afterResolve`.
 */
function afterResolve(graphLike: unknown): CompiledGraph<string> {
  const graph = isUncompiledBuilder(graphLike)
    ? graphLike.compile()
    : (graphLike as CompiledGraph<string>);
  const inner = (graph as { graph?: unknown }).graph;
  if (inner != null && typeof inner === "object" && isCompiledGraphLike(inner)) {
    return inner as CompiledGraph<string>;
  }
  return graph;
}

/**
 * Load the graph for a spec: import the module, read the export (falling back to `default`),
 * and resolve it. A compiled-graph export is returned ready to run; a factory export is
 * returned un-invoked (as a {@link CompiledGraphFactory}) so the caller can supply per-run
 * config, exactly as LangGraph does.
 */
export async function loadGraph(spec: GraphSpec): Promise<ResolvedGraph> {
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(spec.sourceFile).href)) as Record<string, unknown>;
  } catch (cause) {
    throw new SkeinConfigError(`Failed to import graph module "${spec.sourceFile}".`, { cause });
  }

  const exportSymbol = spec.exportSymbol || "default";
  const exported = module[exportSymbol];
  // `== null` catches both a missing export and an explicit `null`/`undefined` one.
  if (exported == null) {
    throw new SkeinConfigError(`Module "${spec.sourceFile}" has no export "${exportSymbol}".`);
  }

  if (typeof exported === "function") {
    const factory = exported as CompiledGraphFactory;
    return async (config) => afterResolve(await factory(config));
  }
  return afterResolve(exported);
}
