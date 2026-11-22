import { expect, test } from "@playwright/test";

// A real browser checks streamed replies, tool cards, and approval against Gemini.
// The suite skips when GOOGLE_API_KEY is missing.
const hasKey = Boolean(process.env["GOOGLE_API_KEY"]);

test.skip(!hasKey, "requires GOOGLE_API_KEY to drive a live Gemini model");

test("streams a reply and shows a structured tool card", async ({ page }) => {
  await page.goto("/");

  // The history sidebar is present from the start.
  await expect(page.getByTestId("chat-sidebar")).toBeVisible();

  await page
    .getByTestId("composer-input")
    .fill("Plan a trip to Tokyo: check the weather there and find flights from San Francisco.");
  await page.getByTestId("send-button").click();

  // The assistant turn appears and the answer streams in.
  const assistant = page.getByTestId("assistant-message").first();
  await expect(assistant).toBeVisible({ timeout: 90_000 });

  // The agent used at least one tool, and its result rendered as a rich card (weather or flights) —
  // the "structured JSON, not raw text" payoff.
  await expect(page.getByTestId("tool-call").first()).toBeVisible({ timeout: 90_000 });
  await expect(
    page.getByTestId("weather-card").or(page.getByTestId("flight-results")).first(),
  ).toBeVisible({ timeout: 90_000 });

  // And a non-empty answer landed.
  await expect(assistant).toContainText(/[a-z]/i, { timeout: 90_000 });
});

// Best-effort (model-timing-dependent): ask to book, then drive the human-in-the-loop gate. The
// booking chain (search_flights → book_flight → interrupt) depends on the model choosing to book, so
// this is a softer check — it waits for the approval card, approves, and asserts a confirmation.
test("pauses for approval before booking, then resumes on approve", async ({ page }) => {
  await page.goto("/");

  await page
    .getByTestId("composer-input")
    .fill("Find flights from San Francisco to Tokyo and book the cheapest one.");
  await page.getByTestId("send-button").click();

  // The run pauses on `book_flight`'s interrupt and the approval card appears.
  const approval = page.getByTestId("approval-card");
  await expect(approval).toBeVisible({ timeout: 120_000 });

  // Approving resumes the run via a Command; a booking confirmation card lands.
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("booking-confirmation")).toBeVisible({ timeout: 90_000 });
});
