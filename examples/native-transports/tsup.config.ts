import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/embedded.ts", "src/backend.ts", "src/producer.ts"],
  format: ["esm"],
  clean: true,
  // SQLite is a Node builtin, not the unrelated npm package named `sqlite`.
  removeNodeProtocol: false,
});
