#!/usr/bin/env node
// Render the social share card (docs/.vitepress/og-card.html) to docs/public/og.png at 1200×630.
//
// Run `pnpm docs:og` after editing the card's copy. The PNG is committed — CI and the Pages deploy
// do not have a browser, and a share card that only exists when someone remembers to regenerate it
// is a share card that is silently missing when a link gets posted.
//
// Playwright is deliberately NOT a root dependency — this script runs by hand a few times a year,
// and a headless browser in every contributor's install is a poor trade for that. It is resolved
// from examples/chat-app, which already needs it for e2e tests.

import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const require = createRequire(import.meta.url);
let chromium;
try {
  const entry = require.resolve("@playwright/test", {
    paths: [path.join(repoRoot, "examples/chat-app")],
  });
  // `@playwright/test` is CJS, so a dynamic import lands the exports under `default`.
  const playwright = await import(pathToFileURL(entry).href);
  chromium = playwright.chromium ?? playwright.default?.chromium;
} catch {
  console.error(
    "Could not load Playwright. Run `pnpm install`, then `pnpm --filter @skein-js/example-chat-app exec playwright install chromium`.",
  );
  process.exit(1);
}
const source = path.join(repoRoot, "docs/.vitepress/og-card.html");
const output = path.join(repoRoot, "docs/public/og.png");

await mkdir(path.dirname(output), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
await page.screenshot({ path: output });
await browser.close();

console.log(`Wrote ${path.relative(repoRoot, output)} (1200×630)`);
