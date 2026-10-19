import { copyFileSync, mkdirSync } from "node:fs";
import { build } from "tsup";

const example = process.argv[2];
if (example === "local-workflow") {
  await build({ entry: ["src/index.ts", "src/ui.ts"], format: ["esm"], dts: true, clean: true });
} else if (example === "local-cli") {
  await build({ entry: ["src/index.ts"], format: ["esm"], clean: true });
} else {
  await build({
    entry: example === "desktop-electron" ? ["src/main.ts", "src/backend.ts"] : ["src/backend.ts"],
    format: ["esm"],
    external: ["electron"],
    clean: true,
  });
  if (example === "desktop-electron")
    await build({
      entry: ["src/preload.ts"],
      format: ["cjs"],
      external: ["electron"],
      clean: false,
    });
  await build({
    entry: ["src/renderer.ts"],
    format: ["esm"],
    platform: "browser",
    noExternal: [/.*/],
    splitting: false,
    clean: false,
  });
  mkdirSync("dist", { recursive: true });
  copyFileSync("src/index.html", "dist/index.html");
  copyFileSync("../local-workflow/src/styles.css", "dist/styles.css");
}
