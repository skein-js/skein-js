// Hermetic unit tests for the research agent's building blocks — no model, no API key, no network.
// The live SDK tests in server.test.ts use a Gemini key.

import { SkeinBaseStore } from "@skein-js/langgraph";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryNamespace, recallMemories, saveMemory, searchWeb } from "./research-tools.js";

const newStore = () => new SkeinBaseStore(new MemorySkeinStore().store);

describe("searchWeb", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports a missing key before making a request", async () => {
    vi.stubEnv("TAVILY_API_KEY", undefined);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(searchWeb("skein-js")).rejects.toThrow("Set TAVILY_API_KEY");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces a search failure without returning invented results", async () => {
    vi.stubEnv("TAVILY_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));

    await expect(searchWeb("skein-js")).rejects.toThrow("Tavily search returned HTTP 429");
  });
});

describe("long-term memory", () => {
  it("namespaces memories per user", () => {
    expect(memoryNamespace("ada")).toEqual(["memories", "ada"]);
  });

  it("saves and recalls a memory for a user", async () => {
    const store = newStore();
    await saveMemory(store, "ada", "Prefers metric units", "m1");
    await saveMemory(store, "ada", "Working on a physics paper", "m2");

    const recalled = await recallMemories(store, "ada", "units");
    expect(recalled).toContain("Prefers metric units");
  });

  it("keeps one user's memories out of another's recall", async () => {
    const store = newStore();
    // Same search term ("morning") in both users' memories, but different namespaces.
    await saveMemory(store, "ada", "Enjoys tea in the morning", "a1");
    await saveMemory(store, "bob", "Enjoys coffee in the morning", "b1");

    const forBob = await recallMemories(store, "bob", "morning");
    expect(forBob).toEqual(["Enjoys coffee in the morning"]);
  });
});
