import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@langchain/langgraph-sdk/client";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, it } from "vitest";

import { startConsoleFixture } from "./fixture-server.js";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof startConsoleFixture>>;
let client: Client;
async function newPage(options: Parameters<Browser["newPage"]>[0] = {}) {
  const page = await browser.newPage(options);
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => console.error("Browser error:", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Browser console:", message.text());
  });
  return page;
}
afterEach(async (context) => {
  if (!browser || context.task.result?.state !== "fail") return;
  for (const browserContext of browser.contexts())
    for (const page of browserContext.pages()) {
      console.error("Failed page:", await page.locator("body").innerText());
      await page.screenshot({
        animations: "disabled",
        path: resolve("../../../dist/console-failure.png"),
        fullPage: true,
      });
    }
});
async function openAssistant(page: Page, assistant: string) {
  const thread = await client.threads.create({ metadata: { assistant_id: assistant } });
  await page.goto(`${fixture.url}${fixture.mountPath}/#/playground/${thread.thread_id}`);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  return thread.thread_id;
}
beforeAll(async () => {
  fixture = await startConsoleFixture();
  client = new Client({ apiUrl: fixture.url });
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await fixture?.close();
});

it("shows real tool activity, token output, a nonboolean pause, failure and resumed success", async () => {
  const page = await newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openAssistant(page, "research");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Find useful documents");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Tool requested · search_library")).toBeVisible();
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Research complete" })).toBeVisible();
  await expect(page.getByText("Output reported · research")).toBeVisible();
  await openAssistant(page, "approval");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Prepare a document");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Needs your input", { exact: true })).toBeVisible();
  await expect(page.getByText(/Edit the proposed document title/).first()).toBeVisible();
  await page
    .getByRole("textbox", { name: "Resume value (JSON)" })
    .fill('{"title":"Reviewed draft"}');
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText(/Saved title:/)).toBeVisible();
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  await openAssistant(page, "failure");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Try this source");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "document source is unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(
    "Try this source",
  );
  expect(errors).toEqual([]);
  await page.close();
});

it("stops execution explicitly and keeps an observed background run alive when its view closes", async () => {
  const page = await newPage();
  const thread = await openAssistant(page, "slow");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Slow research");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Run in progress", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop run", exact: true }).click();
  await expect.poll(async () => (await client.runs.list(thread))[0]?.status).toBe("cancelled");
  await expect(page.getByText("Run stopped", { exact: true })).toBeVisible();
  const background = await client.runs.create(null, "slow", {
    input: { messages: [{ role: "human", content: "observe" }] },
  });
  await page.goto(
    `${fixture.url}/console/#/threads/${background.thread_id}/runs/${background.run_id}`,
  );
  await expect(page.getByText("Following reported events.", { exact: false })).toBeVisible();
  await page.close();
  await expect
    .poll(async () => (await client.runs.get(background.thread_id, background.run_id)).status)
    .toBe("success");
});

it("creates and restores Assistants, writes memory with retention, and creates a thread schedule", async () => {
  const page = await newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${fixture.url}/console/#/assistants`);
  await page.getByRole("button", { name: "New Assistant", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Graph ID", { exact: true }).fill("research");
  await dialog.getByLabel("Name", { exact: true }).fill("Research preview");
  await dialog.getByRole("button", { name: "Create Assistant", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save assistant", exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Research revised");
  await page.getByRole("button", { name: "Save assistant", exact: true }).click();
  await page.getByRole("button", { name: "Preview version 1", exact: true }).click();
  await page.getByRole("button", { name: "Restore this version", exact: true }).click();
  await page.getByRole("button", { name: "Restore version", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Research preview");
  await page.goto(`${fixture.url}/console/#/store`);
  await page.getByRole("button", { name: "New item", exact: true }).click();
  await page.getByLabel("Namespace", { exact: true }).fill("docs/review");
  await page.getByLabel("Key", { exact: true }).fill("draft");
  await page.getByLabel("Value (JSON)", { exact: true }).fill('{"title":"Review"}');
  await page.getByLabel("Retention", { exact: true }).selectOption("custom");
  await page.getByRole("button", { name: "Create item", exact: true }).click();
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.getByText("Lifetime: 60 minutes", { exact: true })).toBeVisible();
  const thread = await client.threads.create();
  await page.goto(`${fixture.url}/console/#/crons`);
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await page.getByLabel("Assistant", { exact: true }).fill("research");
  await page.getByLabel("Thread scope", { exact: true }).selectOption("thread");
  await page.getByLabel("Existing thread ID", { exact: true }).fill(thread.thread_id);
  await page.getByRole("button", { name: "Create schedule", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.close();
});

it("renders light and dark themes at all planned sizes without page overflow and restores dialog focus", async () => {
  const directory = resolve("../../../dist/console-screenshots");
  await mkdir(directory, { recursive: true });
  const page = await newPage();
  await openAssistant(page, "research");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Find useful documents");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      localStorage.setItem("skein-console:theme", value);
    }, theme);
    await page.reload();
    for (const width of [390, 768, 1280, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.getByRole("heading", { name: "Playground", exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: resolve(directory, `playground-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
  await page.close();
});

it("preserves separate drafts after validation, request, and partial-batch failures without resubmission", async () => {
  const page = await newPage();
  await openAssistant(page, "research");
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  const json = page.getByRole("textbox", { name: "Graph input (JSON)", exact: true });
  await json.fill("{ invalid");
  await page.getByRole("button", { name: "Run input", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(json).toHaveValue("{ invalid");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Keep this draft");
  let submissions = 0;
  await page.route(/\/runs\/stream$/, async (route) => {
    submissions++;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"message":"Unavailable fixture"}',
    });
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(message).toHaveValue("Keep this draft");
  expect(submissions).toBe(1);
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await expect(json).toHaveValue("{ invalid");
  await page.getByText("Advanced run options", { exact: true }).click();
  await page.getByLabel("Run scope", { exact: true }).selectOption("batch");
  await json.fill('[{"messages":[]},{"messages":[]}]');
  let batches = 0;
  await page.route(/\/runs\/batch$/, async (route) => {
    batches++;
    await client.runs.create(null, "research", { input: { messages: [] } });
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"message":"Second admission failed"}',
    });
  });
  await page.getByRole("button", { name: "Run input", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("may already have created some runs");
  await expect(json).toHaveValue('[{"messages":[]},{"messages":[]}]');
  expect(batches).toBe(1);
  await page.close();
});

it("submits exact advanced options for stateless, delayed, keyed, batch, and existing-thread runs", async () => {
  const page = await newPage();
  await openAssistant(page, "slow");
  await page.getByText("Advanced run options", { exact: true }).click();
  await page.getByLabel("Run scope", { exact: true }).selectOption("stateless");
  await page.getByLabel("Start after (seconds)", { exact: true }).fill("1");
  await page.getByLabel("Execution timeout (milliseconds)", { exact: true }).fill("25");
  await page.getByLabel("Idempotency key (optional)", { exact: true }).fill("browser-key");
  await page.getByLabel("If the thread is busy", { exact: true }).selectOption("enqueue");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Duration proof");
  const submitted = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/runs",
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const request = await submitted;
  expect(request.postDataJSON()).toMatchObject({
    assistant_id: "slow",
    after_seconds: 1,
    timeout_ms: 25,
    on_completion: "keep",
    multitask_strategy: "enqueue",
  });
  expect(request.headers()["idempotency-key"]).toBe("browser-key");
  await expect(page.getByRole("alert")).toContainText("timeout");
  await openAssistant(page, "research");
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.getByText("Advanced run options", { exact: true }).click();
  await page.getByLabel("Run scope", { exact: true }).selectOption("batch");
  await page.getByLabel("If the thread is busy", { exact: true }).selectOption("rollback");
  await page
    .getByRole("textbox", { name: "Graph input (JSON)", exact: true })
    .fill('[{"messages":[]},{"messages":[]}]');
  const batchRequest = page.waitForRequest(/\/runs\/batch$/);
  await page.getByRole("button", { name: "Run input", exact: true }).click();
  expect((await batchRequest).postDataJSON()).toEqual([
    expect.objectContaining({
      assistant_id: "research",
      multitask_strategy: "rollback",
      on_completion: "keep",
      stream_mode: ["values", "messages-tuple", "updates"],
    }),
    expect.objectContaining({ assistant_id: "research" }),
  ]);
  await expect(page.getByText("Created 2 runs", { exact: true })).toBeVisible();
  const target = await client.threads.create();
  await page.getByLabel("Run scope", { exact: true }).selectOption("thread");
  await page.getByLabel("Existing thread ID (optional)", { exact: true }).fill(target.thread_id);
  await page.getByLabel("If the thread is busy", { exact: true }).selectOption("interrupt");
  await page
    .getByRole("textbox", { name: "Graph input (JSON)", exact: true })
    .fill('{"messages":[]}');
  const existingRequest = page.waitForRequest(
    new RegExp(`/threads/${target.thread_id}/runs/stream$`),
  );
  await page.getByRole("button", { name: "Run input", exact: true }).click();
  expect((await existingRequest).postDataJSON()).toMatchObject({ multitask_strategy: "interrupt" });
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  await page.getByLabel("Run scope", { exact: true }).selectOption("stateless");
  await page.getByLabel("After completion", { exact: true }).selectOption("delete");
  await page
    .getByRole("textbox", { name: "Graph input (JSON)", exact: true })
    .fill('{"messages":[]}');
  const ephemeralResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/runs",
  );
  await page.getByRole("button", { name: "Run input", exact: true }).click();
  const ephemeral = (await (await ephemeralResponse).json()) as { thread_id: string };
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  await expect(page.getByText(/The generated thread was deleted as requested/)).toBeVisible();
  await expect
    .poll(async () => {
      try {
        await client.threads.get(ephemeral.thread_id);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.close();
});

it("copies, edits, retains, trims, and deletes threads with actual affected counts", async () => {
  const page = await newPage({ viewport: { width: 1440, height: 1000 } });
  const thread = await openAssistant(page, "research");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Thread operations");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  await page.goto(`${fixture.url}/console/#/threads/${thread}`);
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await page.getByLabel("Metadata (JSON)", { exact: true }).fill('{"reviewed":true}');
  await page.getByRole("button", { name: "Save metadata", exact: true }).click();
  await expect.poll(async () => (await client.threads.get(thread)).metadata?.reviewed).toBe(true);
  await page.getByLabel("Retention", { exact: true }).selectOption("custom");
  await page.getByLabel("Lifetime (minutes)", { exact: true }).fill("30");
  await page
    .getByRole("combobox", { name: "When the lifetime expires" })
    .selectOption("keep_latest");
  await page.getByRole("button", { name: "Save retention", exact: true }).click();
  await expect(page.getByText("Retention saved.", { exact: true })).toBeVisible();
  await expect
    .poll(async () => ((await client.threads.get(thread)) as unknown as { ttl: number }).ttl)
    .toBe(30);
  await page.getByRole("button", { name: "Copy thread", exact: true }).click();
  await expect.poll(() => page.url()).not.toContain(thread);
  const copied = page.url().split("/").at(-1)!;
  expect(copied).not.toBe(thread);
  expect((await client.threads.get(copied)).metadata?.reviewed).toBe(true);
  await page.getByRole("button", { name: "Trim history", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Trim history", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /history|changed/i })).toBeVisible();
  await page.getByRole("button", { name: "Delete thread", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete thread", exact: true })
    .click();
  await expect
    .poll(async () => {
      try {
        await client.threads.get(copied);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  const bulk = await client.threads.create({ metadata: { graph_id: "bulk-browser" } });
  await page.goto(`${fixture.url}/console/#/threads?graph=bulk-browser`);
  await page
    .getByRole("checkbox", { name: `Select thread ${bulk.thread_id}`, exact: true })
    .check();
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await expect(
    page.getByText("1 of 1 selected threads changed. 0 unchanged, unavailable, or skipped.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.close();
});

it("reads, overwrites, and deletes memory while requiring an explicit fallback for unsupported passive reads", async () => {
  const page = await newPage();
  await client.store.putItem(["browser-memory"], "editable", { title: "Original" }, { ttl: 30 });
  await page.goto(`${fixture.url}/console/#/store`);
  await page.getByRole("button", { name: "editable", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Original");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Edit editable", exact: true }).click();
  await page.getByLabel("Value (JSON)", { exact: true }).fill('{"title":"Revised"}');
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save item", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await client.store.getItem(["browser-memory"], "editable", { refreshTtl: false }))?.value
          .title,
    )
    .toBe("Revised");
  await page.getByRole("button", { name: "Delete editable", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete item", exact: true }).click();
  await expect(page.getByRole("button", { name: "editable", exact: true })).toHaveCount(0);
  const reads: boolean[] = [];
  await page.route(/\/store\/items\/search$/, async (route) => {
    const refresh = route.request().postDataJSON().refresh_ttl;
    reads.push(refresh !== false);
    if (refresh === false)
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: '{"message":"The configured store does not support per-operation TTL options."}',
      });
    else await route.continue();
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Load using normal reads", exact: true }),
  ).toBeVisible();
  expect(reads.every((refresh) => !refresh)).toBe(true);
  await page.getByRole("button", { name: "Load using normal reads", exact: true }).click();
  await expect.poll(() => reads.includes(true)).toBe(true);
  await page.close();
});

it("edits scheduling fields without changing the saved payload and keeps threads when deleting an Assistant", async () => {
  const page = await newPage();
  const schedule = await client.crons.create("research", {
    schedule: "0 9 * * 1-5",
    input: { messages: [], custom: "preserve me" },
    timezone: "UTC",
    onRunCompleted: "keep",
  });
  await page.goto(`${fixture.url}/console/#/crons`);
  await page.getByRole("button", { name: "0 9 * * 1-5", exact: true }).click();
  await page.getByLabel("Cron expression", { exact: true }).fill("0 10 * * 1-5");
  await page.getByText("Timezone, end time, and retention", { exact: true }).click();
  await page.getByLabel("Schedule timezone", { exact: true }).fill("Africa/Nairobi");
  const patch = page.waitForRequest(
    (request) => request.method() === "PATCH" && request.url().includes(schedule.cron_id),
  );
  await page.getByRole("button", { name: "Save schedule", exact: true }).click();
  expect((await patch).postDataJSON()).toEqual({
    schedule: "0 10 * * 1-5",
    timezone: "Africa/Nairobi",
  });
  await expect
    .poll(
      async () =>
        (await client.crons.search()).find((cron) => cron.cron_id === schedule.cron_id)?.payload,
    )
    .toMatchObject({ input: { custom: "preserve me" } });
  const assistant = await client.assistants.create({
    graphId: "research",
    name: "Temporary Assistant",
  });
  const thread = await client.threads.create({
    metadata: { assistant_id: assistant.assistant_id },
  });
  await page.goto(`${fixture.url}/console/#/assistants/${assistant.assistant_id}`);
  await page.getByRole("button", { name: "Delete Assistant", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete Assistant", exact: true })
    .click();
  await expect
    .poll(async () => {
      try {
        await client.assistants.get(assistant.assistant_id);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  expect((await client.threads.get(thread.thread_id)).thread_id).toBe(thread.thread_id);
  await page.close();
});

it("renders safe Markdown, preserves a reader's scroll position, and supports inspector keyboard navigation", async () => {
  const page = await newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
  let remoteRequests = 0;
  await page.route("https://media.example/**", (route) => {
    remoteRequests++;
    return route.abort();
  });
  await openAssistant(page, "slow");
  const message =
    "<script>window.injected = true</script>\n\n![untrusted image](https://media.example/image.png)\n\n" +
    "Earlier output\n\n".repeat(70);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open image: untrusted image", exact: true }),
  ).toBeVisible();
  const output = page.getByRole("region", { name: "Conversation output", exact: true });
  await output.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
  expect(
    await page.evaluate(() => (window as Window & { injected?: boolean }).injected),
  ).toBeUndefined();
  expect(remoteRequests).toBe(0);
  await page.getByRole("tab", { name: "Activity", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Graph", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "State", exact: true })).toBeFocused();
  await page.close();
});

it("captures current documentation screens in light and dark themes", async () => {
  const directory = resolve("../../../dist/console-screenshots/docs");
  await mkdir(directory, { recursive: true });
  const page = await newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const conversation = await openAssistant(page, "research");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Find documents about durable agent runtimes.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  const interrupted = await openAssistant(page, "approval");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Prepare the document for review.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Needs your input", { exact: true })).toBeVisible();
  await client.assistants.update("research", {
    name: "Library research",
    description: "Find documents, inspect evidence, and prepare a reviewed summary.",
  });
  const run = await client.runs.create(null, "research", {
    input: { messages: [{ role: "human", content: "Prepare a summary for the review callback." }] },
    webhook: "https://callbacks.example.test/research-complete",
  });
  await expect
    .poll(async () => (await client.runs.get(run.thread_id, run.run_id)).status)
    .toBe("success");
  await expect
    .poll(async () => (await fixture.store.deliveries!.listByRun(run.run_id))[0]?.last_error)
    .toContain("HTTP 503");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => localStorage.setItem("skein-console:theme", value), theme);
    for (const [name, route] of [
      ["playground", `playground/${conversation}`],
      ["overview", "overview"],
      ["threads", "threads?status=interrupted"],
      ["interrupts", `playground/${interrupted}`],
      ["store", "store"],
      ["assistants", "assistants"],
      ["assistant-detail", "assistants/research"],
      ["thread-detail", `threads/${conversation}`],
      ["run", `threads/${run.thread_id}/runs/${run.run_id}`],
      ["channels", "channels"],
      ["schedules", "crons"],
    ]) {
      await page.goto(`${fixture.url}/console/#/${route}`);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (name === "playground")
        await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
      if (name === "interrupts")
        await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      if (name === "store")
        await expect(page.getByRole("button", { name: "draft", exact: true })).toBeVisible();
      if (name === "threads") await expect(page.getByRole("checkbox").first()).toBeVisible();
      if (name === "assistants")
        await expect(
          page.getByRole("button", { name: "New Assistant", exact: true }),
        ).toBeVisible();
      if (name === "assistant-detail")
        await expect(
          page.getByRole("button", { name: "Save assistant", exact: true }),
        ).toBeVisible();
      if (name === "thread-detail")
        await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        );
      if (name === "run")
        await expect(page.getByText("Execution status: success", { exact: true })).toBeVisible();
      if (name === "channels")
        await expect(
          page.getByRole("cell", { name: "library", exact: false }).first(),
        ).toBeVisible();
      if (name === "schedules")
        await expect(page.getByRole("button", { name: "New schedule", exact: true })).toBeVisible();
      if (name === "playground" || name === "interrupts")
        await page
          .getByRole("region", { name: "Conversation output", exact: true })
          .evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
      await page.screenshot({
        animations: "disabled",
        path: resolve(directory, `${name}-${theme}.png`),
        fullPage: true,
      });
    }
    const detailDirectory = resolve(directory, "details");
    await mkdir(detailDirectory, { recursive: true });
    await page.goto(`${fixture.url}/console/#/threads/${conversation}`);
    for (const tab of ["State", "Runs", "Details", "Checkpoints"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      if (tab === "Details")
        await expect(
          page.getByRole("button", { name: "Save retention", exact: true }),
        ).toBeVisible();
      if (tab === "Checkpoints")
        await expect(page.getByRole("button", { name: "Open", exact: true }).first()).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        path: resolve(detailDirectory, `thread-${tab.toLowerCase()}-${theme}.png`),
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "Open", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Fork here", exact: true })).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: resolve(detailDirectory, `time-travel-${theme}.png`),
      fullPage: true,
    });
    await page.goto(`${fixture.url}/console/#/threads/${run.thread_id}/runs/${run.run_id}`);
    for (const tab of ["Raw events", "Deliveries", "Details"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      if (tab === "Deliveries")
        await expect(
          page.getByText(/Fixture callback receiver returned HTTP 503/).first(),
        ).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        path: resolve(
          detailDirectory,
          `run-${tab.toLowerCase().replaceAll(" ", "-")}-${theme}.png`,
        ),
        fullPage: true,
      });
    }
  }
  await page.close();
});

it("keeps resource layouts within the viewport with readable theme contrast", async () => {
  const page = await newPage();
  const thread = await client.threads.create();
  const routes = [
    "assistants/research",
    `threads/${thread.thread_id}`,
    "overview",
    "channels",
    "store",
    "crons",
  ];
  for (const theme of ["light", "dark"]) {
    await page.goto(`${fixture.url}/console/`);
    await page.evaluate((value) => localStorage.setItem("skein-console:theme", value), theme);
    await page.reload();
    for (const width of [390, 768, 1280, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of routes) {
        await page.goto(`${fixture.url}/console/#/${route}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= window.innerWidth &&
              document.documentElement.scrollHeight <= window.innerHeight,
          ),
          `${theme}/${width}/${route}`,
        ).toBe(true);
      }
    }
    const contrast = await page.evaluate(() => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      const sample = document.createElement("div");
      document.body.append(sample);
      const results = [
        "foreground",
        "muted-foreground",
        "status-running",
        "status-success",
        "status-error",
        "status-interrupted",
      ].map((token) => {
        sample.style.color = `hsl(var(--${token}))`;
        sample.style.background = "hsl(var(--background))";
        const style = getComputedStyle(sample),
          foreground = luminance(style.color),
          background = luminance(style.backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        );
      });
      sample.remove();
      return results;
    });
    for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
  await page.close();
});

it("creates threads lazily and keeps ordinary submissions available when capability discovery fails", async () => {
  const page = await newPage();
  await page.route(/\/info$/, (route) =>
    route.fulfill({ status: 503, body: "Capability discovery unavailable" }),
  );
  await page.route(/\/assistants\/[^/]+\/schemas$/, (route) =>
    route.fulfill({ status: 503, body: "Schema discovery unavailable" }),
  );
  const count = await client.threads.count();
  await page.goto(`${fixture.url}/console/#/playground`);
  await expect(page.getByRole("combobox", { name: "Assistant", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  if (!(await page.locator('option[value="research"]').count())) {
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator('option[value="research"]')).toHaveCount(1);
  }
  await page.getByRole("combobox", { name: "Assistant", exact: true }).selectOption("research");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  await expect(page.getByText("Input schema unavailable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  expect(await client.threads.count()).toBe(count);
  await page.getByText("Advanced run options", { exact: true }).click();
  await expect(page.getByLabel("Execution timeout (milliseconds)", { exact: true })).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Create this thread only now");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  expect(await client.threads.count()).toBe(count + 1);
  await page.reload();
  await expect(page.getByText("Output reported · answer", { exact: true })).toBeVisible();
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  await page.close();
});

it("keeps the sidebar and composer inside short viewports while output and advanced controls scroll", async () => {
  const directory = resolve("../../../dist/console-screenshots/viewport");
  await mkdir(directory, { recursive: true });
  const page = await newPage();
  await openAssistant(page, "research");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Long conversation\n\n".repeat(80));
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible();
  const output = page.getByRole("region", { name: "Conversation output", exact: true });
  for (const viewport of [
    { width: 1440, height: 760 },
    { width: 1280, height: 640 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeInViewport({
      ratio: 1,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
      JSON.stringify(viewport),
    ).toBe(true);
    expect(await output.evaluate((element) => element.clientHeight)).toBeGreaterThan(0);
    if (viewport.width >= 768)
      await expect(page.getByRole("link", { name: "Console guide ↗", exact: true })).toBeInViewport(
        { ratio: 1 },
      );
    await page.screenshot({
      animations: "disabled",
      path: resolve(directory, `playground-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.getByText("Advanced run options", { exact: true }).click();
  await page.getByLabel("Idempotency key (optional)", { exact: true }).fill("viewport-proof");
  await page.getByRole("button", { name: "Send message", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeInViewport({
    ratio: 1,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: resolve(directory, "advanced-1280x640.png"),
    fullPage: true,
  });
  await page.getByText("Advanced run options", { exact: true }).click();
  await openAssistant(page, "approval");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Review in a short window");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Needs your input", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Resume value (JSON)", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("textbox", { name: "Resume value (JSON)", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeInViewport({
    ratio: 1,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: resolve(directory, "interrupt-1280x640.png"),
    fullPage: true,
  });
  await page.close();
});
