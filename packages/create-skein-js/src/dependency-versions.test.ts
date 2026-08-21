// Drift guard between the versions a scaffolded project pins and the versions the runnable examples
// use.
//
// The examples are typechecked in CI and are what the docs link to, so they are the live proof that
// a combination of versions works. If someone bumps an example without bumping the scaffolder, a
// new user's first project is stale — and nothing else in the repo would notice. Hence this test,
// and hence the explicit `{workspaceRoot}/examples/*/package.json` entry in the `test` target's
// inputs in project.json (without it Nx would replay a cached pass and never re-run this).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CORE_VERSIONS, PROVIDER_DETAILS, TOOLCHAIN_VERSIONS } from "./dependency-versions.js";
import { resolveSkeinVersionRange } from "./skein-version.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(packageRoot, "../..");

function readManifest(relativePath: string): {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(workspaceRoot, relativePath), "utf8"));
}

describe("the versions a scaffolded project pins", () => {
  const example = readManifest("examples/express-basic/package.json");
  const exampleVersions = { ...example.dependencies, ...example.devDependencies };

  it.each([
    "@langchain/core",
    "@langchain/langgraph",
    "@langchain/langgraph-sdk",
    "langchain",
    "zod",
  ] as const)("pins %s to the range examples/express-basic uses", (packageName) => {
    expect(CORE_VERSIONS[packageName]).toBe(exampleVersions[packageName]);
  });

  it("pins @langchain/google-genai to the range examples/express-basic uses", () => {
    expect(PROVIDER_DETAILS.google.versionRange).toBe(exampleVersions["@langchain/google-genai"]);
  });

  it("pins the toolchain to the workspace's own ranges", () => {
    const root = readManifest("package.json");
    expect(TOOLCHAIN_VERSIONS["@types/node"]).toBe(root.devDependencies?.["@types/node"]);
    expect(TOOLCHAIN_VERSIONS["typescript"]).toBe(root.devDependencies?.["typescript"]);
  });

  // `nx release` versions packages/* as a fixed group, so the scaffolder's own version IS the
  // runtime version it should pin. That identity is what lets us skip a registry lookup entirely.
  it("derives the skein range from this package's own version", () => {
    const own = readManifest("packages/create-skein-js/package.json");
    expect(resolveSkeinVersionRange()).toBe(`^${own.version}`);
  });
});
