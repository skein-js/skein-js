// Boot validation. Every case here is a mistake that would otherwise surface when the first real
// customer sends a message, which is the worst possible time to discover a typo in a config key.

import { describe, expect, it, vi } from "vitest";

import { buildChannelRegistry, type ChannelConfig } from "./registry.js";

const validChannel = { name: "twilio", verify: vi.fn(), parseEvent: vi.fn() };

function build(
  config: Partial<ChannelConfig> = {},
  module: unknown = validChannel,
  graphIds: string[] = ["support", "triage"],
) {
  return buildChannelRegistry({
    channels: { twilio: { module, config: { assistant: "support", ...config } } },
    graphIds,
  });
}

describe("buildChannelRegistry", () => {
  it("registers a valid channel", () => {
    expect(build().get("twilio")?.channel.name).toBe("twilio");
    expect(build().names).toEqual(["twilio"]);
  });

  it("refuses an assistant that names no graph", () => {
    // The motivating case. Nothing else reads this key, so without a boot check the first sign of a
    // typo is a 404 in front of a customer.
    expect(() => build({ assistant: "suport" })).toThrow(/not one of this deployment's graphs/);
  });

  it("names the graphs that do exist, so the typo is obvious", () => {
    expect(() => build({ assistant: "suport" })).toThrow(/support, triage/);
  });

  it("refuses a missing assistant", () => {
    // Not defaulted, because the binding is deployment knowledge — a community adapter has no
    // business knowing what you named your graph.
    expect(() => build({ assistant: "" })).toThrow(/has no "assistant"/);
  });

  it("lets a UUID through unchecked", () => {
    // It addresses an assistant created over the API, which does not exist yet at boot.
    expect(() => build({ assistant: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" })).not.toThrow();
  });

  it("refuses an allowed_assistants entry that names no graph", () => {
    expect(() => build({ allowedAssistants: ["ghost"] })).toThrow(/allowed_assistants/);
  });

  it("refuses a public_url that is not absolute", () => {
    // It has to be an origin a provider could have signed; a path fragment cannot be one.
    expect(() => build({ publicUrl: "/channels/twilio" })).toThrow(/not an absolute URL/);
  });

  it("refuses a module that is not a channel", () => {
    // A `path:export` typo lands here — pointing at the graph, or at a module with no such export.
    expect(() => build({}, { notAChannel: true })).toThrow(/must have `verify` and `parseEvent`/);
    expect(() => build({}, null)).toThrow(/must have `verify` and `parseEvent`/);
    // The shape a missing named export actually arrives in.
    expect(() =>
      buildChannelRegistry({
        channels: { twilio: { module: undefined, config: { assistant: "support" } } },
        graphIds: ["support"],
      }),
    ).toThrow(/must have `verify` and `parseEvent`/);
  });

  it("refuses a half-implemented channel", () => {
    // `verify` is required precisely because a channel that skips it is an unauthenticated
    // run-creation endpoint. Missing it must fail at boot, not be treated as "no verification".
    expect(() => build({}, { parseEvent: vi.fn() })).toThrow(/must have `verify`/);
  });

  it("names a channel that did not name itself", () => {
    // So the config key is always a usable identity, even for a channel that omits `name`.
    const registry = build({}, { verify: vi.fn(), parseEvent: vi.fn() });
    expect(registry.get("twilio")?.channel.name).toBe("twilio");
  });

  it("has nothing at all when nothing is configured", () => {
    // Goal G5: a deployment that never configures a channel cannot tell the feature exists — and an
    // empty registry is what keeps the routes out of the table entirely.
    expect(buildChannelRegistry({ channels: {}, graphIds: ["support"] }).names).toEqual([]);
  });
});
