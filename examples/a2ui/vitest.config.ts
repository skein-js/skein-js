import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    watch: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
