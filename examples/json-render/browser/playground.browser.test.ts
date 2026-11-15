import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, preview, type PreviewServer } from "vite";
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
    if (request.prompt === "Stream a table") {
      const patches = demoSpecStream(request)
        .split("\n")
        .map((line) => JSON.parse(line));
      const table = patches.find((patch) => patch.path === "/elements/table");
      const props = table.value.props;
      table.value.props = {};
      const beforeTable = patches.indexOf(table);
      const split = patches.findIndex((patch) => patch.value === "table") + 1;
      yield patches
        .slice(0, beforeTable)
        .map((patch) => JSON.stringify(patch))
        .join("\n") + "\n";
      yield patches
        .slice(beforeTable, split)
        .map((patch) => JSON.stringify(patch))
        .join("\n") + "\n";
      await new Promise<void>((resolve) => {
        releaseUpdates = resolve;
      });
      yield JSON.stringify({ op: "add", path: "/elements/table/props", value: props }) + "\n";
      yield patches
        .slice(split)
        .map((patch) => JSON.stringify(patch))
        .join("\n");
      return;
    }
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

it("keeps rendering while streamed table props are incomplete", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.getByLabel("Describe the UI").fill("Stream a table");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("heading", { name: "Website traffic dashboard" }).waitFor();
    expect(await page.getByRole("table").count()).toBe(0);
    expect(errors).toEqual([]);
    releaseUpdates();
    await page.getByRole("table", { name: "Traffic by channel" }).waitFor();
    await page.getByRole("button", { name: "Approve UI" }).click();
    await page.getByText("UI approved. Keep refining it.").waitFor();
    expect(errors).toEqual([]);
  } finally {
    releaseUpdates();
    await page.close();
  }
});

it("reopens and reloads a thread through the development StrictMode entry", async () => {
  const client = harness.clientFor();
  const thread = await client.threads.create();
  await client.runs.wait(thread.thread_id, "ui-playground", {
    input: { request: { prompt: "Restore this development thread" } },
  });
  const beforeReopen = generations;
  const devServer = await createServer({
    configFile: resolve("vite.config.mts"),
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      proxy: { "/api": { target: harness.url, rewrite: (path) => path.replace(/^\/api/, "") } },
    },
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await devServer.listen();
    const address = devServer.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No development UI listener");
    const threadUrl = "http://127.0.0.1:" + address.port + "/?thread=" + thread.thread_id;
    await page.goto(threadUrl);
    await page
      .locator(".generated")
      .getByText("Restore this development thread", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Approve UI" }).waitFor();
    expect(page.url()).toBe(threadUrl);
    expect(generations).toBe(beforeReopen);
    await page.getByRole("button", { name: "Approve UI" }).click();
    await page.getByText("UI approved. Keep refining it.").waitFor();

    await page.reload();
    await page
      .locator(".generated")
      .getByText("Restore this development thread", { exact: true })
      .waitFor();
    await page.getByText("UI approved. Keep refining it.").waitFor();

    expect(page.url()).toBe(threadUrl);
    expect(generations).toBe(beforeReopen);
    expect(await client.runs.list(thread.thread_id)).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await devServer.close();
  }
});

it("renders progressively, routes buttons and forms, approves, and restores on reload", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.getByLabel("Describe the UI").focus();
    await page.keyboard.press("Tab");
    expect(
      await page
        .getByRole("button", { name: "Send" })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await capture(page, "empty-desktop");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("heading", { name: "Website traffic dashboard" }).waitFor();
    expect(await page.getByRole("button", { name: "Approve UI" }).count()).toBe(0);
    expect(
      await page.getByText("Preview · saving after validation", { exact: true }).isVisible(),
    ).toBe(true);
    await capture(page, "streaming-desktop");
    await page.getByRole("button", { name: "Approve UI" }).click();
    await page.getByText("UI approved. Keep refining it.").waitFor();
    await page.locator(".conversation").evaluate((element) => {
      element.scrollTop = 0;
    });
    await capture(page, "playground-dashboard");
    expect(await page.getByLabel("UI JSON", { exact: true }).textContent()).toContain("Metric");
    await page.getByRole("button", { name: "Make it simpler" }).click();
    await page
      .locator(".generated")
      .getByText("Make this UI simpler: Website traffic dashboard", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page.getByText("UI rejected. Describe another direction.").waitFor();
    await page
      .getByLabel("What would you change?")
      .fill("Use a smaller room and invite ten people");
    await page.getByRole("button", { name: "Update UI" }).click();
    await page
      .locator(".generated")
      .getByText("Use a smaller room and invite ten people", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Approve UI" }).click();
    await page.getByText("UI approved. Keep refining it.").waitFor();
    const beforeReload = generations;
    const savedUrl = page.url();
    expect(new URL(savedUrl).searchParams.get("thread")).toBeTruthy();
    await page.reload();
    await page
      .locator(".generated")
      .getByText("Use a smaller room and invite ten people", { exact: true })
      .waitFor();
    await page.getByText("UI approved. Keep refining it.").waitFor();
    expect(generations).toBe(beforeReload);
    expect(await page.locator(".user-message").count()).toBe(3);
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
    await page.getByLabel("Describe the UI").fill("Reconnect this plan");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("heading", { name: "Website traffic dashboard" }).waitFor();
    await page.getByLabel("Describe the UI").fill("Reconnect this plan");
    await page.getByRole("button", { name: "Pause updates" }).click();
    await page.getByText("Updates paused. The run continues on the server.").waitFor();
    expect(await page.getByLabel("Describe the UI").inputValue()).toBe("Reconnect this plan");
    await capture(page, "paused-desktop");
    const beforeReconnect = generations;
    releaseUpdates();
    await page.getByRole("button", { name: "Reconnect" }).click();
    await page.getByRole("button", { name: "Approve UI" }).waitFor();
    expect(generations).toBe(beforeReconnect);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page.getByText("UI rejected. Describe another direction.").waitFor();
    await page.getByLabel("Describe the UI").fill("Cancel this plan");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Preview · saving after validation", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop run" }).click();
    await page.getByText("Run stopped. Showing saved state.").waitFor();
    await capture(page, "stopped-desktop");
    await page.getByLabel("Describe the UI").fill("Show an error");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("alert").waitFor();
    expect(
      await page
        .locator(".generated")
        .getByText("Reconnect this plan", { exact: true })
        .isVisible(),
    ).toBe(true);
    await capture(page, "error-desktop");
  } finally {
    releaseUpdates();
    await page.close();
  }
});
