import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    name: "console-browser",
    include: ["browser/**/*.browser.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    maxWorkers: 1,
  },
});
