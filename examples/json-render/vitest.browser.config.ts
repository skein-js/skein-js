import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["browser/**/*.browser.test.ts"],
    watch: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
  },
});
