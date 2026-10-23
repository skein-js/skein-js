import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["browser/**/*.browser.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
  },
});
