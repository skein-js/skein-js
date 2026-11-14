import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import { chromium, type Browser, type Page } from "@playwright/test";
import { preview, type PreviewServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { demoMessages, demoResponse, generateDemoText } from "../src/generation.js";
import { rendererMetadata, startHarness } from "../src/test-harness.js";

let browser: Browser;
let uiServer: PreviewServer;
let harness: Awaited<ReturnType<typeof startHarness>>;
let url: string;
let generations = 0;
let releaseUpdates: () => void = () => undefined;
const screenshots = resolve("../../dist/a2ui-screenshots");

beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
  harness = await startHarness(async function* (request, signal) {
    generations++;
    if (request.prompt === "Show an error") {
      yield "<a2ui-json>{invalid}</a2ui-json>";
      return;
    }
    if (["Reconnect this trip", "Cancel this trip"].includes(request.prompt)) {
      const text = demoResponse(request.prompt, request.generationId);
      const prefix =
        "<a2ui-json>[" +
        JSON.stringify(demoMessages(request.prompt, request.generationId)[0]) +
        ",";
      yield prefix;
      if (request.prompt === "Cancel this trip") await pause(20_000, undefined, { signal });
      else
        await new Promise<void>((resolve) => {
          releaseUpdates = resolve;
        });
      yield text.slice(prefix.length);
      return;
    }
    yield* generateDemoText(request, signal);
  });
  const output = resolve("../../dist/examples/a2ui/browser");
  uiServer = await preview({
    configFile: false,
    root: resolve("../.."),
    build: { outDir: output },
    preview: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/api": { target: harness.url, rewrite: (path) => path.replace(/^\/api/, "") },
      },
    },
  });
  const address = uiServer.httpServer.address();
  if (!address || typeof address === "string") throw new Error("No UI listener");
  url = "http://127.0.0.1:" + address.port;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  releaseUpdates();
  await browser?.close();
  if (uiServer)
    await new Promise<void>((resolve, reject) =>
      uiServer.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  await harness?.close();
});

async function capture(page: Page, name: string) {
  await page.screenshot({ path: resolve(screenshots, name + ".png"), fullPage: true });
}

it("streams native Angular surfaces, binds forms, reviews, deletes tips and restores the saved URL", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.getByLabel("Where will curiosity take you?").focus();
    await page.keyboard.press("Tab");
    expect(
      await page
        .getByRole("button", { name: "Plan my trip" })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await capture(page, "empty-desktop");
    await page.getByRole("button", { name: "Plan my trip" }).click();
    await page.getByText("Preview · saving after validation").waitFor();
    await capture(page, "preview-desktop");
    await page.getByRole("button", { name: "Approve itinerary" }).waitFor();
    expect(await page.getByRole("button", { name: "Revise trip", exact: true }).isDisabled()).toBe(
      true,
    );
    await capture(page, "review-desktop");
    await page.getByRole("button", { name: "Approve itinerary" }).click();
    await page.getByText("Itinerary approved. You can keep exploring.").waitFor();
    await page
      .getByLabel("What would you change?")
      .fill("  Less walking, more markets and a picnic  ");
    await page.keyboard.press("Tab");
    expect(
      await page
        .getByRole("button", { name: "Revise trip", exact: true })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await capture(page, "revision-keyboard-focus");
    await page.keyboard.press("Enter");
    await page.getByText("Less walking, more markets and a picnic", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page
      .getByText("Itinerary rejected. Use the revision form to try another direction.")
      .waitFor();
    await page.getByRole("button", { name: "Make it more relaxed" }).click();
    await page
      .getByText("Make this trip more relaxed: Less walking, more markets and a picnic", {
        exact: true,
      })
      .waitFor();
    await page.getByRole("button", { name: "Approve itinerary" }).click();
    await page.getByText("Itinerary approved. You can keep exploring.").waitFor();
    const beforeDismiss = generations;
    await page.getByRole("button", { name: "Dismiss travel tips" }).click();
    await page
      .getByRole("region", { name: "A little travel wisdom" })
      .waitFor({ state: "detached" });
    expect(generations).toBe(beforeDismiss);
    const savedUrl = page.url();
    expect(new URL(savedUrl).searchParams.get("thread")).toBeTruthy();
    await page.reload();
    await page.getByText("Itinerary approved. You can keep exploring.").waitFor();
    expect(page.url()).toBe(savedUrl);
    expect(await page.getByRole("button", { name: "Dismiss travel tips" }).count()).toBe(0);
    expect(generations).toBe(beforeDismiss);
    await capture(page, "approved-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await capture(page, "approved-mobile");
    expect(errors).toEqual([]);
  } finally {
    await capture(page, "last-journey-desktop");
    await page.close();
  }
});

it("reconnects to one run and preserves saved UI on cancellation and invalid generation", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  try {
    await page.goto(url);
    await page.getByLabel("Where will curiosity take you?").fill("Reconnect this trip");
    await page.getByRole("button", { name: "Plan my trip" }).click();
    await page.getByText("Making room for a little adventure…").waitFor();
    await page.getByRole("button", { name: "Pause updates" }).click();
    await page.getByText("Updates paused. The run continues on the server.").waitFor();
    await capture(page, "paused-desktop");
    const beforeReconnect = generations;
    releaseUpdates();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.getByRole("button", { name: "Approve itinerary" }).click();
    await page.getByText("Itinerary approved. You can keep exploring.").waitFor();
    expect(generations).toBe(beforeReconnect);
    await page.getByLabel("Where will curiosity take you?").fill("Cancel this trip");
    await page.getByRole("button", { name: "Plan my trip" }).click();
    await page.getByText("Preview · saving after validation").waitFor();
    await page.getByRole("button", { name: "Stop run" }).click();
    await page.getByText("Run stopped. Showing saved state.").waitFor();
    await capture(page, "stopped-desktop");
    await page.getByLabel("Where will curiosity take you?").fill("Show an error");
    await page.getByRole("button", { name: "Plan my trip" }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByText("Reconnect this trip", { exact: true }).isVisible()).toBe(true);
    await capture(page, "error-desktop");
  } finally {
    releaseUpdates();
    await capture(page, "last-recovery-desktop");
    await page.close();
  }
});

it("reopens pending review without generation and rejects an incompatible saved snapshot", async () => {
  const client = harness.clientFor();
  const thread = await client.threads.create();
  await client.runs.wait(thread.thread_id, "trip-planner", {
    input: {
      request: {
        kind: "plan",
        prompt: "A saved pending itinerary",
        metadata: rendererMetadata(),
      },
    },
  });
  const before = generations;
  const page = await browser.newPage();
  try {
    await page.goto(url + "/?thread=" + thread.thread_id);
    await page.getByRole("button", { name: "Approve itinerary" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Approve itinerary" }).waitFor();
    expect(generations).toBe(before);
    await client.threads.updateState(thread.thread_id, { values: { ui: { schemaVersion: 99 } } });
    await page.reload();
    await page.getByRole("alert").filter({ hasText: "incompatible" }).waitFor();
    expect(await page.getByRole("button", { name: "Plan my trip" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "New trip", exact: true }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Plan my trip" }).isEnabled())
      .toBe(true);
    expect(new URL(page.url()).searchParams.has("thread")).toBe(false);
    expect(generations).toBe(before);
  } finally {
    await page.close();
  }
});
