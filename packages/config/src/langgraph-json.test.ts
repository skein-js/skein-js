import { describe, expect, it } from "vitest";

import { SkeinConfigError } from "./errors.js";
import { parseLanggraphJson } from "./langgraph-json.js";

describe("parseLanggraphJson", () => {
  it("accepts a minimal valid config", () => {
    const config = parseLanggraphJson({ graphs: { agent: "./src/agent.ts:graph" } });
    expect(config.graphs).toEqual({ agent: "./src/agent.ts:graph" });
  });

  it("preserves known optional fields", () => {
    const config = parseLanggraphJson({
      graphs: { agent: "./a.ts:graph" },
      node_version: "20",
      env: ".env",
      checkpointer: { type: "default" },
    });
    expect(config.node_version).toBe("20");
    expect(config.checkpointer).toEqual({ type: "default" });
  });

  it("passes unknown keys through unchanged (so an existing config round-trips)", () => {
    const config = parseLanggraphJson({ graphs: {}, future_field: 42 }) as Record<string, unknown>;
    expect(config["future_field"]).toBe(42);
  });

  it("throws SkeinConfigError with issue details when graphs is missing", () => {
    try {
      parseLanggraphJson({ node_version: "20" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SkeinConfigError);
      expect((error as SkeinConfigError).details).toBeDefined();
    }
  });

  it("throws when a graph value is not a string", () => {
    expect(() => parseLanggraphJson({ graphs: { agent: 123 } })).toThrow(SkeinConfigError);
  });
});
