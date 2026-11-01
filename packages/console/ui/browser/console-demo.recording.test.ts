import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { it } from "vitest";

import { startConsoleFixture } from "./fixture-server.js";

/** Deliberate pauses give viewers time to read; assertions, rather than pauses, await UI readiness. */
async function pauseForViewer(page: Page, milliseconds = 2000) {
  await page.waitForTimeout(milliseconds);
}

async function clickForViewer(page: Page, target: Locator) {
  await target.hover();
  const bounds = await target.boundingBox();
  if (bounds)
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 16 });
  await pauseForViewer(page, 400);
  await target.click();
}

it("records the console documentation walkthrough", async () => {
  const directory = resolve("../../../dist/console-recordings");
  await mkdir(directory, { recursive: true });
  const fixture = await startConsoleFixture();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: "light",
      reducedMotion: "reduce",
      recordVideo: { dir: directory, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      // A visible pointer belongs to the recording only; product markup is unchanged.
      window.addEventListener("DOMContentLoaded", () => {
        const pointer = document.createElement("div");
        pointer.style.cssText =
          "position:fixed;left:0;top:0;width:18px;height:18px;border:2px solid #0f766e;border-radius:50%;background:#ffffffaa;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0";
        document.body.append(pointer);
        window.addEventListener("mousemove", (event) => {
          pointer.style.left = `${event.clientX}px`;
          pointer.style.top = `${event.clientY}px`;
          pointer.style.opacity = "1";
        });
      });
    });
    await page.goto(`${fixture.url}/console/#/playground?new=1&assistant=research`);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(message).toBeVisible();
    await pauseForViewer(page);
    await clickForViewer(page, message);
    await message.pressSequentially("Find documents about durable agent runtimes.", { delay: 55 });
    await pauseForViewer(page, 800);
    await clickForViewer(page, page.getByRole("button", { name: "Send message", exact: true }));
    await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
    await pauseForViewer(page, 3000);

    await clickForViewer(page, message);
    const draft = "Compare their checkpoint recovery behavior.";
    await message.pressSequentially(draft, { delay: 55 });
    await pauseForViewer(page);
    await clickForViewer(page, page.getByRole("link", { name: "Inspect thread", exact: true }));
    await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toBeVisible();
    await pauseForViewer(page);
    await clickForViewer(page, page.getByRole("tab", { name: "Runs", exact: true }));
    await pauseForViewer(page);
    await clickForViewer(page, page.getByRole("link", { name: "Open in Playground", exact: true }));
    await expect(message).toHaveValue(draft);
    await pauseForViewer(page, 2500);

    await clickForViewer(
      page,
      page.getByRole("navigation").getByRole("link", { name: "Threads", exact: true }),
    );
    const row = page
      .getByRole("row")
      .filter({ hasText: "Find documents about durable agent runtimes." });
    await expect(row).toBeVisible();
    await pauseForViewer(page, 2500);
    await clickForViewer(page, row.getByRole("link", { name: "Open in Playground", exact: true }));
    await expect(message).toHaveValue(draft);
    await pauseForViewer(page);
    await clickForViewer(page, page.getByRole("button", { name: "Recent threads", exact: true }));
    const recentThread = page
      .getByRole("dialog")
      .getByRole("link", { name: "Find documents about durable agent runtimes.", exact: true });
    await expect(recentThread).toBeVisible();
    await pauseForViewer(page, 3000);
    await clickForViewer(page, recentThread);
    await expect(message).toHaveValue(draft);
    await pauseForViewer(page, 2500);
    expect(errors).toEqual([]);

    const video = page.video();
    await context.close();
    if (!video) throw new Error("The browser did not produce a recording");
    await video.saveAs(resolve(directory, "console-walkthrough.webm"));
    console.log(`Recorded ${resolve(directory, "console-walkthrough.webm")}`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
