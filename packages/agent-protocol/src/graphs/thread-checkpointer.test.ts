// The assignability fact `ThreadCheckpointer` exists to guarantee, plus the one it enables.
//
// If the first breaks, widening `ProtocolDeps.checkpointer` was not additive and every existing
// deployment stops compiling. If the second breaks, the cast this type was introduced to remove is
// back, and "install @skein-js/agent-protocol and bring your own agent" is false again.

import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import type { ThreadCheckpointer } from "./thread-checkpointer.js";

describe("ThreadCheckpointer", () => {
  it("accepts a real LangGraph checkpointer, so widening ProtocolDeps stays additive", () => {
    // The load-bearing line: no cast.
    const checkpointer: ThreadCheckpointer = new MemorySaver();

    expect(typeof checkpointer.getTuple).toBe("function");
    expect(typeof checkpointer.list).toBe("function");
    expect(typeof checkpointer.put).toBe("function");
    expect(typeof checkpointer.putWrites).toBe("function");
    expect(typeof checkpointer.deleteThread).toBe("function");
  });

  it("accepts a hand-written stand-in with no casts", () => {
    // What a deployment with no checkpoints supplies. Phase 1 needed
    // `as unknown as ProtocolDeps["checkpointer"]` here; this asserts that cast is gone.
    const checkpointer: ThreadCheckpointer = {
      async getTuple() {
        return undefined;
      },
      async *list() {
        // nothing stored
      },
      async put(config) {
        return config;
      },
      async putWrites() {},
      async deleteThread() {},
    };

    expect(checkpointer.getTuple({ configurable: { thread_id: "t" } })).resolves.toBeUndefined();
  });
});
