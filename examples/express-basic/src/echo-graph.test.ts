import { HumanMessage } from "@langchain/core/messages";
import { describe, it, expect } from "vitest";

import { graph } from "./echo-graph.js";

describe("echo graph", () => {
  it("echoes the last human message", async () => {
    const result = await graph.invoke({ messages: [new HumanMessage("hello")] });
    const last = result.messages.at(-1);
    expect(last?.content).toBe("echo: hello");
  });

  it("handles an empty conversation without throwing", async () => {
    const result = await graph.invoke({ messages: [] });
    expect(result.messages.at(-1)?.content).toBe("echo: ");
  });
});
