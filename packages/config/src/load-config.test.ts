import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { SkeinConfigError } from "./errors.js";
import { loadConfig } from "./load-config.js";

// The headline conformance target: load the real example's unchanged langgraph.json and
// resolve one of its graphs to a graph we can actually run (docs/roadmap.md verification).
const exampleDir = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../examples/express-basic",
);

describe("loadConfig", () => {
  it("loads the example langgraph.json and registers its graphs", async () => {
    const { config, configDir, graphs } = await loadConfig({ cwd: exampleDir });

    expect(configDir).toBe(exampleDir);
    expect(config.graphs).toHaveProperty("echo");
    expect(graphs.ids).toEqual(expect.arrayContaining(["echo", "agent"]));
  });

  it("resolves the echo graph to a runnable compiled graph", async () => {
    const { graphs } = await loadConfig({ cwd: exampleDir });

    const echo = await graphs.load("echo");
    // The echo export is a compiled graph, not a factory function.
    if (typeof echo === "function") throw new Error("expected a compiled graph, got a factory");
    // Proves it is genuinely a compiled LangGraph, not just an imported symbol.
    const result = (await echo.invoke({ messages: [{ role: "user", content: "hi" }] })) as {
      messages: Array<{ content: unknown }>;
    };

    const last = result.messages.at(-1);
    expect(last?.content).toBe("echo: hi");
  });

  it("extracts JSON schemas for a graph via langgraph-api", async () => {
    const { graphs } = await loadConfig({ cwd: exampleDir });
    const schemas = await graphs.schemas("echo");
    // langgraph-api keys schemas by subgraph namespace; the root graph is present with the
    // standard state/input/output/config fields.
    const root = schemas["graph"];
    expect(root).toBeDefined();
    expect(root).toHaveProperty("state");
    expect(root).toHaveProperty("input");
  }, 30_000);

  it("routes graph loading through a custom importModule (used by `skein dev`'s vite loader)", async () => {
    const imported: string[] = [];

    const { graphs } = await loadConfig({
      cwd: exampleDir,
      importModule: async (sourceFile) => {
        imported.push(sourceFile);
        return (await import(pathToFileURL(sourceFile).href)) as Record<string, unknown>;
      },
    });

    const echo = await graphs.load("echo");
    expect(typeof echo === "function" ? "factory" : "graph").toBe("graph");
    expect(imported.some((file) => file.endsWith("echo-graph.ts"))).toBe(true);

    // Schemas are static source analysis, independent of the importer, so introspection still works.
    const schemas = await graphs.schemas("echo");
    expect(schemas["graph"]).toHaveProperty("state");
  }, 30_000);

  it("serves precomputed schemas without parsing TypeScript when staticSchemas is set", async () => {
    // The production image (`skein build`/`start`) ships bundled JS with no `.ts` to introspect, so
    // schemas are baked at build time and served from a map. Point the source at a non-existent file
    // to prove `getStaticGraphSchema` is never called (it would throw trying to read it).
    const baked = { graph: { graph_id: "echo", state: {} } };

    const { graphs } = await loadConfig({
      cwd: exampleDir,
      staticSchemas: { echo: baked as never },
    });

    await expect(graphs.schemas("echo")).resolves.toBe(baked);
  });

  it("throws when a graph has no precomputed schema in staticSchemas", async () => {
    const { graphs } = await loadConfig({ cwd: exampleDir, staticSchemas: {} });
    // Known id, but no baked schema for it — a build/manifest mismatch, surfaced as a config error.
    await expect(graphs.schemas("echo")).rejects.toBeInstanceOf(SkeinConfigError);
    // Unknown id still rejects via the same spec validation as the dynamic path.
    await expect(graphs.schemas("nope")).rejects.toBeInstanceOf(SkeinConfigError);
  });

  it("caches the compiled graph across loads", async () => {
    const { graphs } = await loadConfig({ cwd: exampleDir });
    const [a, b] = await Promise.all([graphs.load("echo"), graphs.load("echo")]);
    expect(a).toBe(b);
  });

  it("throws for an unknown graph id", async () => {
    const { graphs } = await loadConfig({ cwd: exampleDir });
    await expect(graphs.load("nope")).rejects.toBeInstanceOf(SkeinConfigError);
    expect(() => graphs.spec("nope")).toThrow(SkeinConfigError);
  });

  it("throws SkeinConfigError when langgraph.json is missing", async () => {
    await expect(
      loadConfig({ cwd: exampleDir, configPath: "does-not-exist.json" }),
    ).rejects.toBeInstanceOf(SkeinConfigError);
  });
});
