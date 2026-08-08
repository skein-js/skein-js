/// <reference types='vitest' />
import { nxViteTsPaths } from "@nx/vite/plugins/nx-tsconfig-paths.plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The console SPA. Two settings carry the whole mounting story:
//
//   base: "./"  — every asset is referenced *relatively*, so the same build works whether it is
//                 served from `/console/`, from a host app's own prefix, or from a static site. An
//                 absolute base would hard-code one mount point into the published package.
//   outDir      — kept inside the project (`ui/dist`) rather than the workspace-wide `dist/`, because
//                 scripts/generate-assets.mjs reads it as build input for @skein-js/console.
//
// There is no SSR and no server runtime: `vite build` emits plain static files, which is exactly what
// lets the generator compile them into a JS module the skein server can serve. Routing is hash-based
// (src/router.ts), so a deep link never reaches the server and no adapter needs a history fallback.
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: "../../../node_modules/.vite/packages/console/ui",
  base: "./",
  server: { port: 4200, host: "localhost" },
  preview: { port: 4200, host: "localhost" },
  plugins: [react(), nxViteTsPaths()],
  // The shadcn/ui convention: components are vendored into src/components/ui and import each other
  // (and `@/lib/utils`) through this alias. Declared here as well as in tsconfig.json because the two
  // resolvers are separate — TypeScript's paths type-check the imports, this one bundles them.
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    reportCompressedSize: true,
    // Stable, unhashed filenames: the assets are compiled into a JS module and served from memory, so
    // cache-busting hashes buy nothing and would churn the generated file on every build.
    rollupOptions: {
      output: {
        entryFileNames: "assets/console.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  test: {
    name: "console-ui",
    watch: false,
    globals: true,
    environment: "jsdom",
    include: ["{src,tests}/**/*.{test,spec}.{ts,mts,tsx}"],
    reporters: ["default"],
    passWithNoTests: true,
    coverage: {
      reportsDirectory: "../../../coverage/packages/console/ui",
      provider: "v8" as const,
    },
  },
}));
