import path from "node:path";
import { fileURLToPath } from "node:url";

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
