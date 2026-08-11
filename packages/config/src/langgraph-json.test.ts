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

  it("accepts a native production runtime", () => {
    const config = parseLanggraphJson({
      graphs: { agent: "./a.ts:graph" },
      skein: { runtime: { name: "bun", version: "1.3.14" } },
    });
    expect(config.skein?.runtime).toEqual({ name: "bun", version: "1.3.14" });
  });

  it("rejects an unknown production runtime", () => {
    expect(() =>
      parseLanggraphJson({
        graphs: { agent: "./a.ts:graph" },
        skein: { runtime: { name: "workerd" } },
      }),
    ).toThrow(SkeinConfigError);
  });

  it("accepts a webhook delivery policy", () => {
    const config = parseLanggraphJson({
      graphs: { agent: "./a.ts:graph" },
      skein: {
        webhooks: {
          retries: { max_attempts: 6, initial_delay_ms: 500 },
          allowed_hosts: ["hooks.example.com"],
        },
      },
    });
    expect(config.skein?.webhooks).toEqual({
      retries: { max_attempts: 6, initial_delay_ms: 500 },
      allowed_hosts: ["hooks.example.com"],
    });
  });

  it("rejects a zero attempt count rather than letting it become an off switch", () => {
    // `.positive()`, not a bare number: `0` survives the engine's `?? default` fallback (`??` only
    // falls through on nullish), so it would accept a `webhook`, record the delivery, and never send
    // it — a callback silently owed forever. Same trap `skein.idempotency` documents.
    expect(() =>
      parseLanggraphJson({
        graphs: { agent: "./a.ts:graph" },
        skein: { webhooks: { retries: { max_attempts: 0 } } },
      }),
    ).toThrow(SkeinConfigError);
    expect(() =>
      parseLanggraphJson({
        graphs: { agent: "./a.ts:graph" },
        skein: { webhooks: { retries: { initial_delay_ms: 0 } } },
      }),
    ).toThrow(SkeinConfigError);
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
