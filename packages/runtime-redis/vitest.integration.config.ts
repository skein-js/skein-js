import { defineConfig } from "vitest/config";

// Testcontainers integration suites. Run via `nx test-integration <project>`. Needs Docker.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
  },
});
