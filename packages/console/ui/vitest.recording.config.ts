import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "console-recording",
    include: ["browser/**/*.recording.test.ts"],
    testTimeout: 90000,
    hookTimeout: 60000,
    maxWorkers: 1,
  },
});
