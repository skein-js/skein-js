import { expect, it } from "vitest";

import { answerText, thinkingText } from "./messages.js";

it("separates a Gemini thought summary from the answer", () => {
  const content = [
    { type: "thinking", thinking: "Compare cache policies under burst traffic." },
    { type: "text", text: "Use LRU as a starting point." },
  ];

  expect(thinkingText(content)).toBe("Compare cache policies under burst traffic.");
  expect(answerText(content)).toBe("Use LRU as a starting point.");
});

it("shows no thought summary for a plain answer", () => {
  expect(thinkingText("Use LRU as a starting point.")).toBe("");
});
