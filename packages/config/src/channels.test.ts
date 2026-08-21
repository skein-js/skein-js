// Loading the channel modules `skein.channels` names.
//
// The messages matter as much as the behaviour here: every failure in this file happens at boot, and
// the whole reason to check at boot is so an operator reads a sentence that names the mistake instead
// of discovering it when the first customer sends a message.

import { describe, expect, it, vi } from "vitest";

import { loadChannels } from "./channels.js";

const channel = { name: "twilio", verify: () => false, parseEvent: () => ({ kind: "ignore" }) };

function importer(modules: Record<string, Record<string, unknown>>) {
  return vi.fn(async (sourceFile: string) => {
    const found = Object.entries(modules).find(([suffix]) => sourceFile.endsWith(suffix));
    if (!found) throw new Error(`no such module: ${sourceFile}`);
    return found[1];
  });
}

describe("loadChannels", () => {
  it("loads nothing when nothing is configured", async () => {
    // Goal G5: a deployment that never configures a channel cannot tell the feature exists.
    expect(await loadChannels(undefined, { configDir: "/app" })).toEqual({});
  });

  it("resolves a path:export spec against the config directory", async () => {
    const importModule = importer({ "src/twilio-channel.ts": { channel } });

    const loaded = await loadChannels(
      { twilio: { path: "./src/twilio-channel.ts:channel", assistant: "support" } },
      { configDir: "/app", importModule },
    );

    expect(loaded["twilio"]?.module).toBe(channel);
    expect(importModule).toHaveBeenCalledWith("/app/src/twilio-channel.ts");
  });

  it("carries the deployment's binding alongside the module", async () => {
    const loaded = await loadChannels(
      {
        twilio: {
          path: "./c.ts:channel",
          assistant: "support",
          allowed_assistants: ["triage"],
          public_url: "https://api.example.com",
        },
      },
      { configDir: "/app", importModule: importer({ "c.ts": { channel } }) },
    );

    expect(loaded["twilio"]).toMatchObject({
      assistant: "support",
      allowedAssistants: ["triage"],
      publicUrl: "https://api.example.com",
    });
  });

  it("names the exports a file does have when the named one is missing", async () => {
    // "The file loaded but has no such export" and "the export is not a channel" are different
    // mistakes with different fixes — reporting the first as the second sends you to the wrong file.
    const importModule = importer({ "c.ts": { graph: {}, somethingElse: {} } });

    await expect(
      loadChannels(
        { twilio: { path: "./c.ts:channel", assistant: "support" } },
        { configDir: "/app", importModule },
      ),
    ).rejects.toThrow(/does not export.*available: graph, somethingElse/s);
  });

  it("says which file failed to import", async () => {
    await expect(
      loadChannels(
        { twilio: { path: "./missing.ts:channel", assistant: "support" } },
        { configDir: "/app", importModule: importer({}) },
      ),
    ).rejects.toThrow(/\/app\/missing\.ts.*could not be imported/s);
  });

  it("treats a bare specifier as a package, not a path", async () => {
    // A published adapter and a file in your own repo are configured the same way, so the spec has to
    // distinguish them the way Node does rather than by a separate config key.
    const importModule = importer({});

    await expect(
      loadChannels(
        { twilio: { path: "@skein-js/channel-twilio", assistant: "support" } },
        { configDir: "/app", importModule },
      ),
    ).rejects.toThrow(/Is it installed\?/);
    // The path importer is never consulted for a package specifier.
    expect(importModule).not.toHaveBeenCalled();
  });

  it("loads every configured channel, not just the first", async () => {
    const loaded = await loadChannels(
      {
        twilio: { path: "./a.ts:channel", assistant: "support" },
        github: { path: "./b.ts:channel", assistant: "triage" },
      },
      {
        configDir: "/app",
        importModule: importer({ "a.ts": { channel }, "b.ts": { channel } }),
      },
    );

    expect(Object.keys(loaded)).toEqual(["twilio", "github"]);
  });
});
