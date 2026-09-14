import { expect, it } from "vitest";

import { runRefundDemo } from "./refund-demo.js";

it("runs the refund walkthrough and prints the approval and audit trace", async () => {
  const lines: string[] = [];
  await runRefundDemo((line) => lines.push(line));

  expect(lines).toEqual(
    expect.arrayContaining([
      expect.stringContaining("three parallel approvals"),
      "3. finance approves over authenticated WhatsApp.",
      "3. hr approves over authenticated WhatsApp.",
      "3. manager approves over authenticated WhatsApp.",
      expect.stringContaining("Final destination: email"),
      expect.stringContaining("finance: approve"),
      expect.stringContaining("hr: approve"),
      expect.stringContaining("manager: approve"),
    ]),
  );
});
