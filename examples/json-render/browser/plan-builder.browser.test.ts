import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import { chromium, type Browser, type Page } from "@playwright/test";
import { preview, type PreviewServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { demoSpecStream, generateDemoText } from "../src/generation.js";
import { startHarness } from "../src/test-harness.js";

let browser: Browser;
let uiServer: PreviewServer;
let harness: Awaited<ReturnType<typeof startHarness>>;
let url: string;
let generations = 0;
let releaseUpdates: () => void = () => undefined;
const screenshots = resolve("../../dist/json-render-screenshots");

beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
  harness = await startHarness(async function* (request, signal) {
    generations++;
    if (request.prompt === "Show an error") {
      yield "invalid generated UI";
      return;
    }
    if (request.prompt === "Reconnect this plan" || request.prompt === "Cancel this plan") {
      const text = demoSpecStream(request);
      const split = text.indexOf("\n", text.indexOf("\n") + 1) + 1;
      yield text.slice(0, split);
      if (request.prompt === "Cancel this plan") await pause(20_000, undefined, { signal });
      else
        await new Promise<void>((resolve) => {
          releaseUpdates = resolve;
        });
      yield text.slice(split);
      return;
    }
    yield* generateDemoText(request, signal);
  });
  uiServer = await preview({
    configFile: resolve("vite.config.mts"),
    preview: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/api": { target: harness.url, rewrite: (path) => path.replace(/^\/api/, "") } },
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

it("renders progressively, routes buttons and forms, approves, and restores on reload", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.getByLabel("What are you planning?").focus();
    await page.keyboard.press("Tab");
    expect(
      await page
        .getByRole("button", { name: "Build a plan" })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await capture(page, "empty-desktop");
    await page.getByRole("button", { name: "Build a plan" }).click();
    await page.getByRole("heading", { name: "Your next steps" }).waitFor();
    expect(await page.getByRole("button", { name: "Approve plan" }).count()).toBe(0);
    expect(await page.getByText("Preview", { exact: true }).isVisible()).toBe(true);
    await capture(page, "streaming-desktop");
    await page.getByRole("button", { name: "Approve plan" }).click();
    await page.getByText("Plan approved. You can keep refining it.").waitFor();
    await page.getByRole("button", { name: "Make it more focused" }).click();
    await page
      .getByText("Focus on one next step: Plan a small community workshop", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page.getByText("Plan rejected. Change your request or use the revision form.").waitFor();
    await page
      .getByLabel("What would you change?")
      .fill("Use a smaller room and invite ten people");
    await page.getByRole("button", { name: "Revise plan" }).click();
    await page.getByText("Use a smaller room and invite ten people", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Approve plan" }).click();
    await page.getByText("Plan approved. You can keep refining it.").waitFor();
    const beforeReload = generations;
    const savedUrl = page.url();
    expect(new URL(savedUrl).searchParams.get("thread")).toBeTruthy();
    await page.reload();
    await page.getByText("Use a smaller room and invite ten people", { exact: true }).waitFor();
    await page.getByText("Plan approved. You can keep refining it.").waitFor();
    expect(generations).toBe(beforeReload);
    await capture(page, "approved-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await capture(page, "approved-mobile");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

it("reconnects without another generation and displays cancellation and errors", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  try {
    await page.goto(url);
    await page.getByLabel("What are you planning?").fill("Reconnect this plan");
    await page.getByRole("button", { name: "Build a plan" }).click();
    await page.getByRole("heading", { name: "Your next steps" }).waitFor();
    await page.getByRole("button", { name: "Pause updates" }).click();
    await page.getByText("Updates paused. The run continues on the server.").waitFor();
    await capture(page, "paused-desktop");
    const beforeReconnect = generations;
    releaseUpdates();
    await page.getByRole("button", { name: "Reconnect" }).click();
    await page.getByRole("button", { name: "Approve plan" }).waitFor();
    expect(generations).toBe(beforeReconnect);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page.getByText("Plan rejected. Change your request or use the revision form.").waitFor();
    await page.getByLabel("What are you planning?").fill("Cancel this plan");
    await page.getByRole("button", { name: "Build a plan" }).click();
    await page.getByText("Preview", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop run" }).click();
    await page.getByText("Run stopped. Showing saved state.").waitFor();
    await capture(page, "stopped-desktop");
    await page.getByLabel("What are you planning?").fill("Show an error");
    await page.getByRole("button", { name: "Build a plan" }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByText("Reconnect this plan", { exact: true }).isVisible()).toBe(true);
    await capture(page, "error-desktop");
  } finally {
    releaseUpdates();
    await page.close();
  }
});
