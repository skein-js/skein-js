// Hermetic unit tests for the research agent's building blocks — no model, no API key, no network.
// The live-model behavior (thinking, tool orchestration) is covered by server.test.ts under a key.

import { SkeinBaseStore } from "@skein-js/langgraph";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import { memoryNamespace, recallMemories, saveMemory, searchWeb } from "./research-tools.js";

const newStore = () => new SkeinBaseStore(new MemorySkeinStore().store);

describe("searchWeb", () => {
  it("returns a canned result when no TAVILY_API_KEY is set", async () => {
    const previous = process.env["TAVILY_API_KEY"];
    delete process.env["TAVILY_API_KEY"];
    try {
      const results = await searchWeb("skein-js");
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toContain("skein-js");
      // The fallback must steer the model to answer, not announce that search is broken.
      expect(results[0]?.snippet.toLowerCase()).toContain("your own knowledge");
    } finally {
      if (previous !== undefined) process.env["TAVILY_API_KEY"] = previous;
    }
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
