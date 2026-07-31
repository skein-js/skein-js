import { describe, expect, it } from "vitest";

import { resolveRuntimeSelection } from "./runtime-selection.js";

const config = {
  graphs: {},
  node_version: "20",
  skein: { runtime: { name: "bun" as const, version: "1.2.0" } },
};

describe("resolveRuntimeSelection", () => {
  it("defaults to Node 24 LTS", () => {
    expect(resolveRuntimeSelection({ graphs: {} })).toEqual({ name: "node", version: "24" });
  });

  it("uses CLI, then config, then defaults", () => {
    expect(resolveRuntimeSelection(config)).toEqual({ name: "bun", version: "1.2.0" });
    expect(resolveRuntimeSelection(config, { runtime: "deno" })).toEqual({
      name: "deno",
      version: "2.9.4",
    });
    expect(resolveRuntimeSelection(config, { runtime: "node", runtimeVersion: "24.4.1" })).toEqual({
      name: "node",
      version: "24.4.1",
    });
  });

  it("continues honoring legacy node_version", () => {
    expect(resolveRuntimeSelection({ graphs: {}, node_version: "20" })).toEqual({
      name: "node",
      version: "20",
    });
  });
});
