import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SkeinConfigError } from "./errors.js";
import { loadGraph, parseGraphSpec, type GraphSpec } from "./graph-spec.js";

describe("parseGraphSpec", () => {
  const baseDir = "/project";

  it("splits path:export and resolves the path against baseDir", () => {
    expect(parseGraphSpec("./src/agent.ts:graph", baseDir)).toEqual({
      sourceFile: path.resolve(baseDir, "./src/agent.ts"),
      exportSymbol: "graph",
    });
  });

  it("supports a factory export symbol", () => {
    expect(parseGraphSpec("./src/chat.ts:makeGraph", baseDir).exportSymbol).toBe("makeGraph");
  });

  it("falls back to the default export for a colon-less spec (matches LangGraph)", () => {
    expect(parseGraphSpec("./src/agent.ts", baseDir)).toEqual({
      sourceFile: path.resolve(baseDir, "./src/agent.ts"),
      exportSymbol: "default",
    });
  });

  it("falls back to the default export for a trailing-colon spec", () => {
    expect(parseGraphSpec("./src/agent.ts:", baseDir).exportSymbol).toBe("default");
  });

  it("splits on the FIRST colon, like LangGraph's `split(':', 2)`", () => {
    expect(parseGraphSpec("./a:b:graph", baseDir)).toEqual({
      sourceFile: path.resolve(baseDir, "./a"),
      exportSymbol: "b",
    });
  });

  it("rejects a spec with no file part", () => {
    expect(() => parseGraphSpec(":graph", baseDir)).toThrow(SkeinConfigError);
    expect(() => parseGraphSpec("", baseDir)).toThrow(SkeinConfigError);
  });
});

const fixture = fileURLToPath(new URL("./__fixtures__/graphs.ts", import.meta.url));
const spec = (exportSymbol: string): GraphSpec => ({ sourceFile: fixture, exportSymbol });
const isRunnable = (g: unknown): boolean =>
  typeof (g as { invoke?: unknown }).invoke === "function";

describe("loadGraph", () => {
  it("returns a compiled-graph export ready to run", async () => {
    const graph = await loadGraph(spec("compiled"));
    expect(typeof graph).not.toBe("function");
    expect(isRunnable(graph)).toBe(true);
  });

  it("compiles an uncompiled StateGraph export (as the LangGraph CLI does)", async () => {
    const graph = await loadGraph(spec("uncompiled"));
    // A raw builder has no `.invoke`; only a compiled graph does.
    expect(isRunnable(graph)).toBe(true);
  });

  it("falls back to the default export when the symbol is empty", async () => {
    const graph = await loadGraph(spec(""));
    expect(isRunnable(graph)).toBe(true);
  });

  it("returns a factory export un-invoked, resolvable with per-run config", async () => {
    const resolved = await loadGraph(spec("factory"));
    expect(typeof resolved).toBe("function");
    if (typeof resolved !== "function") throw new Error("unreachable");
    expect(isRunnable(await resolved({}))).toBe(true);
  });

  it("rejects a null export (not just undefined)", async () => {
    await expect(loadGraph(spec("nothing"))).rejects.toBeInstanceOf(SkeinConfigError);
  });

  it("rejects a missing export", async () => {
    await expect(loadGraph(spec("missing"))).rejects.toBeInstanceOf(SkeinConfigError);
  });
});
