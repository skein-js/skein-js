import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityFeed, describeExecution } from "./activity";

it("distinguishes last reported output from a currently executing node", () => {
  const summary = describeExecution({ running: true, lastNode: "search", pending: 0 });
  expect(summary.description).toContain("Last reported output: search");
  expect(summary.description).toContain("Waiting for the next update");
});
it("explains a nonboolean interrupt before offering another run", () => {
  const summary = describeExecution({ running: false, pending: 1, status: "interrupted" });
  expect(summary.title).toBe("Needs your input");
  expect(summary.description).toContain("submit the value");
});
describe("observed activity", () => {
  it("labels reports without inventing execution timestamps", () => {
    render(
      <ActivityFeed
        frames={[{ seq: 1, event: "updates", data: { research: { result: "found" } } }]}
        dropped={7}
      />,
    );
    expect(screen.getByText("Output reported · research")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("7 earlier events");
  });
});
