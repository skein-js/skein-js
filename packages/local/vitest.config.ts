import { defineConfig } from "vitest/config";

// Fast unit loop: excludes *.integration.test.ts (those need Docker — see
// vitest.integration.config.ts and docs/testing.md). Discovered by @nx/vite as `nx test`.
export default defineConfig({
  test: {
    // Real SQLite files and graph/checkpoint reopening can exceed 5s on Windows CI.
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/dist/**", "**/node_modules/**"],
    passWithNoTests: true,
  },
});
