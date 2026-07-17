import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { hydrateCheckpointer, snapshotCheckpointer } from "./dev-persistence.js";

describe("checkpointer snapshot/hydrate", () => {
  it("round-trips storage and writes through JSON, preserving the blobs", () => {
    const source = new MemorySaver();
    source.storage = {
      thread1: {
        "": {
          cp1: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), undefined],
          cp2: [new Uint8Array([9]), new Uint8Array([8, 7, 6]), "cp1"],
        },
      },
    };
    source.writes = {
      key1: { "task-0": ["task", "channel", new Uint8Array([10, 20, 30])] },
    };

    // Go through a real JSON round-trip, as the CLI does when persisting to disk.
    const snapshot = JSON.parse(JSON.stringify(snapshotCheckpointer(source)));
    const restored = new MemorySaver();
    hydrateCheckpointer(restored, snapshot);

    expect(restored.storage["thread1"]?.[""]?.["cp1"]?.[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(restored.storage["thread1"]?.[""]?.["cp2"]?.[2]).toBe("cp1");
    expect(restored.writes["key1"]?.["task-0"]?.[2]).toEqual(new Uint8Array([10, 20, 30]));
  });

  it("handles an empty checkpointer", () => {
    const restored = new MemorySaver();
    hydrateCheckpointer(restored, snapshotCheckpointer(new MemorySaver()));
    expect(restored.storage).toEqual({});
    expect(restored.writes).toEqual({});
  });
});
