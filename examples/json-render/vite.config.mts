import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxy = {
  "/api": {
    target: "http://127.0.0.1:2024",
    rewrite: (path: string) => path.replace(/^\/api/, ""),
  },
};

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/examples/json-render",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 3006, proxy },
  preview: { host: "127.0.0.1", port: 3006, proxy },
  build: { outDir: "dist", emptyOutDir: true },
});
