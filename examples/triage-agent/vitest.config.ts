import { defineConfig } from "vitest/config";

// Unit tests only — the pure helpers in src/triage-sources.ts. The graphs need a model key and a
// running server, so they are exercised by the manual demo script in README.md, not here.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    passWithNoTests: true,
  },
});
