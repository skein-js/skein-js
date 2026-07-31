import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/dist/**", "**/node_modules/**"],
    passWithNoTests: true,
  },
});
