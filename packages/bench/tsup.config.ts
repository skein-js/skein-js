import { defineConfig } from "tsup";

// The one package here that needs a config file rather than tsup CLI flags: `@skein-js/test-support`
// is private and resolves to TypeScript source (`main: ./src/index.ts`), so Node cannot import it at
// runtime and it has to be bundled in. `noExternal` has no CLI equivalent. Everything else — the
// published `@skein-js/*` packages, express, pg, ioredis — stays external and resolves from
// node_modules as usual.
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  noExternal: ["@skein-js/test-support"],
});
