import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real SQLite files and multi-step fixture graphs can exceed 5s on Windows CI.
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
