// Run a **real** `skein build` over a project, then build the image it produced.
//
// This is the only place the whole chain is exercised end to end: bundle the graphs → pin every
// external into the artifact's `package.json` → `npm install --omit=dev` inside the image → the
// generated Dockerfile's graph compatibility probe. Its sibling `runtime-image-smoke.mjs` builds a
// *committed* artifact instead, so it varies the serving runtime but never runs the bundler — and
// that gap is how issue #6 shipped: `skein build` recorded none of the packages the bundle imports,
// and only `docker build` ever noticed.
//
// Node only. Bundling happens on the host under Node whatever runtime the image uses, so a
// per-runtime matrix here would add cost that cannot differ.
//
// Usage: node scripts/build-image-smoke.mjs [--keep]

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { repoRoot, spliceVendorCopy, vendorLocalPackages } from "./lib/vendor-local-packages.mjs";

const projectDir = path.join(repoRoot, "packages/test-support/fixtures/build-project/apps/app");
const configPath = path.join(projectDir, "langgraph.json");
const artifactDir = path.join(projectDir, ".skein", "build");
const manifestPath = path.join(artifactDir, "package.json");
const skeinCli = path.join(repoRoot, "packages/cli/dist/index.js");
const tag = "skein-build-smoke";

const flags = new Set(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => arg.slice(2)),
);

const failures = [];
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

/**
 * Point the artifact's own manifest at the vendored tarballs, so the image installs *this commit*
 * rather than the published `skein-js` the artifact pins — which does not exist yet on a release
 * commit, and would otherwise make this job fail for a reason that has nothing to do with the build.
 */
function useVendoredPackages() {
  const vendored = vendorLocalPackages(path.join(artifactDir, "vendor"), "tarball");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies["skein-js"] = `file:vendor/${vendored.get("skein-js")}`;
  // Every other `@skein-js/*` is reached through `skein-js`'s own published cross-references; an
  // override is what redirects them at the local tarball.
  manifest.overrides = Object.fromEntries(
    [...vendored.keys()]
      .filter((name) => name !== "skein-js")
      .map((name) => [name, `file:vendor/${vendored.get(name)}`]),
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  spliceVendorCopy(path.join(artifactDir, "Dockerfile"));
  return vendored;
}

function cleanup() {
  if (flags.has("keep")) {
    console.log(`\n--keep: left image ${tag} and ${artifactDir} in place.`);
    return;
  }
  spawnSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
  rmSync(path.join(projectDir, ".skein"), { recursive: true, force: true });
  rmSync(path.join(projectDir, "node_modules"), { recursive: true, force: true });
}

function main() {
  console.log("\n=== build smoke: skein build → docker build ===\n");

  if (!existsSync(skeinCli)) {
    throw new Error(`${skeinCli} is missing — run \`nx run-many -t build\` first`);
  }
  rmSync(path.join(projectDir, ".skein"), { recursive: true, force: true });

  // The fixture declares its own dependencies and is not a workspace package, so the root install
  // never touches it. Exact-pinned in its package.json, so this needs no lockfile to be repeatable.
  console.log("installing the fixture's own dependencies");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], {
    cwd: projectDir,
    stdio: "inherit",
  });

  // `--artifact-only` stops before Docker, which is what lets the vendored packages be spliced in.
  console.log("bundling the fixture project with `skein build --artifact-only`");
  execFileSync("node", [skeinCli, "build", "-c", configPath, "--artifact-only"], {
    stdio: "inherit",
  });

  // The assertion issue #6 was missing. Checked here as well as inside the image so a failure names
  // its cause, instead of surfacing as an opaque `ERR_MODULE_NOT_FOUND` minutes into a docker build —
  // which is why it *stops* rather than recording a failure and building the image anyway.
  const pinned = JSON.parse(readFileSync(manifestPath, "utf8")).dependencies ?? {};
  check(
    "the artifact pins `date-fns`, reachable only through a graph import",
    typeof pinned["date-fns"] === "string",
    `pinned: ${Object.keys(pinned).join(", ")}`,
  );
  if (failures.length > 0) {
    console.log(`\n${checks - failures.length}/${checks} checks passed`);
    process.exitCode = 1;
    return;
  }

  console.log("vendoring local packages into the artifact");
  const vendored = useVendoredPackages();
  check(`vendored ${vendored.size} local packages`, vendored.size > 0);

  console.log(`building ${tag} (the graph compatibility probe runs inside this build)`);
  execFileSync("docker", ["build", "--progress=plain", "-t", tag, artifactDir], {
    stdio: "inherit",
  });
  check("the image builds, including the graph compatibility probe", true);

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`\nbuild smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
