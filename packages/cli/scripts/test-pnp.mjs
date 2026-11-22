// A real, offline Yarn PnP install: archive-backed packages, separate dependency trees, and no
// published fixture packages. The pinned Yarn CLI is provisioned separately from this test.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { run } from "../../../scripts/pack-local-consumer.mjs";

const yarnCli = process.env["SKEIN_PNP_YARN_CLI"];
if (!yarnCli) throw new Error("Set SKEIN_PNP_YARN_CLI to the Yarn 4.9.2 JavaScript entry.");
assert.equal(
  run(process.execPath, [yarnCli, "--version"], { stdio: "pipe", encoding: "utf8" }).stdout.trim(),
  "4.9.2",
);

const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "skein-yarn-pnp-")));

const writeJson = (filename, value) => {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, JSON.stringify(value) + "\n");
};

const env = {
  ...process.env,
  YARN_ENABLE_NETWORK: "false",
  YARN_ENABLE_TELEMETRY: "false",
  YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
};

function createProject(name, version) {
  const project = path.join(directory, name);
  writeJson(path.join(project, "package.json"), {
    name,
    private: true,
    packageManager: "yarn@4.9.2",
    dependencies: {
      "@fixture/subpath-sdk": "file:./sdk",
      "@fixture/hidden": "file:./hidden",
    },
  });
  writeFileSync(
    path.join(project, ".yarnrc.yml"),
    "nodeLinker: pnp\npnpEnableEsmLoader: true\npnpFallbackMode: none\nenableGlobalCache: false\nenableScripts: false\n",
  );
  writeJson(path.join(project, "sdk/package.json"), {
    name: "@fixture/subpath-sdk",
    version,
    exports: {
      "./package.json": "./dist/cjs/package.json",
      "./client/index.js": "./dist/esm/client/index.js",
    },
  });
  writeJson(path.join(project, "sdk/dist/cjs/package.json"), { type: "commonjs" });
  writeJson(path.join(project, "sdk/dist/esm/package.json"), { type: "module" });
  mkdirSync(path.join(project, "sdk/dist/esm/client"));
  writeFileSync(
    path.join(project, "sdk/dist/esm/client/index.js"),
    `export const sdkMarker = ${JSON.stringify(version)};\n`,
  );
  writeJson(path.join(project, "hidden/package.json"), {
    name: "@fixture/hidden",
    version: "4.5.6",
    exports: { ".": "./index.js" },
  });
  writeFileSync(path.join(project, "hidden/index.js"), "exports.marker = 'hidden';\n");
  run(process.execPath, [yarnCli, "install"], { cwd: project, env, timeout: 60_000 });
  return project;
}

try {
  const first = createProject("first-project", "1.32.2");
  const second = createProject("second-project", "9.8.7");
  const ordinary = path.join(directory, "ordinary");
  writeJson(path.join(ordinary, "node_modules/@fixture/subpath-sdk/package.json"), {
    name: "@fixture/subpath-sdk",
    version: "3.2.1",
  });

  // A PnP-managed issuer must not accidentally select an unrelated physical node_modules tree.
  for (const name of ["@fixture/subpath-sdk", "@fixture/unlisted"]) {
    writeJson(path.join(first, "node_modules", name, "package.json"), {
      name,
      version: "99.0.0",
    });
  }

  const probe = path.join(first, "check-resolution.mjs");
  copyFileSync(
    path.resolve(import.meta.dirname, "../src/bundle/__fixtures__/pnp/check-resolution.mjs"),
    probe,
  );
  run(
    process.execPath,
    [
      yarnCli,
      "node",
      "--experimental-strip-types",
      probe,
      path.resolve(import.meta.dirname, "../src/bundle/installed-package-version.ts"),
      first,
      second,
      ordinary,
    ],
    { cwd: first, env, timeout: 60_000 },
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
