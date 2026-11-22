import { defineConfig } from "vitest/config";

// The end-to-end suite boots a real skein server from `langgraph.json` and drives it with the official
// SDK and supplies a test model explicitly.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
