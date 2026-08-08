import { defineConfig } from "vitest/config";

// Fast unit loop: excludes *.integration.test.ts (those need Docker — see docs/testing.md).
// Discovered by @nx/vite as `nx test`. The SPA under ui/ is built by scripts/generate-assets.mjs and
// tested through the generated asset module, so it is not part of this project's test globs.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/dist/**", "**/node_modules/**", "**/ui/**"],
    passWithNoTests: true,
  },
});
