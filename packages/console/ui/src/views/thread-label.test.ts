import { HumanMessage } from "@langchain/core/messages";
import type { Thread } from "@langchain/langgraph-sdk";
import { describe, expect, it } from "vitest";

import { describeThread } from "./thread-label";

function thread(messages: unknown): Pick<Thread, "thread_id" | "values" | "metadata"> {
  return {
    thread_id: "thread-123456789",
    metadata: { graph_id: "research" },
    values: { messages },
  };
}

describe("conversation labels", () => {
  it("uses public SDK normalization for plain, blocked and serialized human messages", () => {
    expect(describeThread(thread([{ type: "human", content: "  Find\n documents " }]))).toBe(
      "Find documents",
    );
    expect(
      describeThread(thread([{ role: "user", content: [{ type: "text", text: "Review draft" }] }])),
    ).toBe("Review draft");
    const serialized: unknown = JSON.parse(
      JSON.stringify([new HumanMessage("Serialized message")]),
    );
    expect(describeThread(thread(serialized))).toBe("Serialized message");
  });
  it("skips malformed/nonhuman entries and falls back for arbitrary graph values", () => {
    expect(
      describeThread(thread([null, { unknown: true }, { type: "ai", content: "Not a prompt" }])),
    ).toBe("research · thread-1");
    expect(describeThread(thread({ task: "structured" }))).toBe("research · thread-1");
    expect(describeThread(thread([{ type: "human", content: "x".repeat(200) }])).length).toBe(101);
  });
});
