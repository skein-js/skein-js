import { defineConfig } from "tsup";

export default defineConfig({
  banner: {
    js: 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);',
  },
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { resolve: ["@skein-js/scaffold"] },
  clean: true,
  noExternal: ["@skein-js/scaffold", "ejs", "picomatch", "semver", "tinyglobby", "yaml", "zod"],
});
