import { defineConfig } from "vitest/config";

// Fast unit loop: excludes *.integration.test.ts (those need Docker — see docs/testing.md).
// Discovered by @nx/vite as `nx test`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/dist/**", "**/node_modules/**"],
    passWithNoTests: true,
  },
});
