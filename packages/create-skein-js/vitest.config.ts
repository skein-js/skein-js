import { defineConfig } from "vitest/config";

// Unit tests over the pure builders. Discovered by @nx/vite as `nx test`.
//
// There is no integration suite here: the end-to-end check — scaffold a project, install it from the
// registry, boot it, serve a run — is scripts/scaffold-smoke.mjs, run by its own CI job, because it
// needs a real network install rather than a container.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    passWithNoTests: true,
  },
});
