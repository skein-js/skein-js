// Guards what a framework adapter drags into a host application's module graph.
//
// The regression this exists to prevent was invisible in any single package: no adapter imported
// `@langchain/langgraph-api`, but every adapter imported `@skein-js/server-kit`, which imported the
// `@skein-js/config` barrel for one error class, and *that* barrel statically imported
// `@langchain/langgraph-api`. So a Next.js app that only ever mounts skein's routes loaded a TypeScript
// graph-schema analyser it never calls. Checking direct imports would not have caught it — the walk
// below follows `@skein-js/*` edges through to their own `dist`, which is where the leak lived.
//
// Static imports only, deliberately: a `await import()` inside a branch that a production server never
// takes is exactly the fix, so counting it as a hit would forbid the remedy.
//
// Lives in test-support because it is a workspace-level assertion. `packages/test-support/project.json`
// gives the `test` target an explicit input covering every package, so editing another package's source
// can't replay a cached pass here.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Packages a host application should never load by mounting skein's routes.
 *
 * `@langchain/langgraph-api` carries the graph-schema analyser (and a TypeScript parser behind it);
 * skein reaches it only to introspect a `langgraph.json` or to adapt a user's `Auth` instance, neither
 * of which happens on a `{ deps }` mount. `superjson` and `@typescript/vfs` are the same shape of
 * problem: dev-time tooling on a production path.
 */
const FORBIDDEN_IN_ADAPTERS = ["@langchain/langgraph-api", "@typescript/vfs", "superjson"];

/** Adapters — the packages that get mounted inside somebody else's server. */
const ADAPTERS = [
  "@skein-js/express",
  "@skein-js/fastify",
  "@skein-js/nestjs",
  "@skein-js/nextjs",
  "@skein-js/fetch",
];

/** `name` → built entry file, for every workspace package that has been built. */
function readBuiltPackages(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifestPath = path.join(packagesDir, dir.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
    const entry = path.join(packagesDir, dir.name, "dist", "index.js");
    if (manifest.name && existsSync(entry)) entries.set(manifest.name, entry);
  }
  return entries;
}

/**
 * Static import/export specifiers in `file`.
 *
 * Three forms, all of which are real static edges: `import … from "x"`, `export … from "x"` (which is
 * why re-exporting a moved symbol "for back-compat" would silently undo a split), and the bare
 * side-effect `import "x"` — which has no `from` at all, and which tsup emits at every chunk boundary,
 * so a matcher that required `from` would quietly stop following part of our own output.
 */
function staticSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const withFrom = [
    ...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;'"]*from\s*["']([^"']+)["']/g),
  ];
  const sideEffect = [...source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)];
  return [...withFrom, ...sideEffect].map((match) => match[1] as string);
}

/**
 * Every module specifier reachable from `entry` through static imports, following `@skein-js/*` edges
 * into their own built output and relative edges within a package. A specifier that resolves to neither
 * is a leaf (a third-party package) and is recorded but not followed.
 */
function reachableSpecifiers(entry: string, builtPackages: Map<string, string>): Set<string> {
  const reached = new Set<string>();
  const visitedFiles = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visitedFiles.has(file) || !existsSync(file)) continue;
    visitedFiles.add(file);

    for (const specifier of staticSpecifiers(file)) {
      reached.add(specifier);
      if (specifier.startsWith(".")) {
        queue.push(path.resolve(path.dirname(file), specifier));
        continue;
      }
      if (!specifier.startsWith("@skein-js/")) continue;
      // A workspace package, including a subpath export: `@skein-js/config/errors` maps to that
      // package's `dist/errors.js`, so a split that moves a symbol behind a subpath is followed
      // accurately rather than being treated as the whole barrel.
      //
      // Unresolvable edges *throw* rather than being skipped. Skipping one is a silent false negative:
      // the walk would stop there and every assertion downstream of it would pass by not looking. That
      // is the failure mode this whole test exists to avoid, so it must not have one of its own.
      const owner = [...builtPackages.keys()].find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (!owner) throw new Error(`No built package for workspace specifier "${specifier}".`);
      const subpath = specifier.slice(owner.length).replace(/^\//, "");
      const target = builtPackages.get(owner) as string;
      const resolved = subpath ? path.join(path.dirname(target), `${subpath}.js`) : target;
      if (!existsSync(resolved)) {
        throw new Error(`"${specifier}" resolved to ${resolved}, which does not exist.`);
      }
      queue.push(resolved);
    }
  }
  return reached;
}

describe("adapter static import graph", () => {
  const builtPackages = readBuiltPackages();
  const adapters = ADAPTERS.filter((name) => builtPackages.has(name));

  // Self-guarding: if the build output moves or a package is renamed, the loop below would silently
  // assert nothing at all.
  it("found every adapter's built entry", () => {
    expect(adapters).toEqual(ADAPTERS);
  });

  it.each(ADAPTERS)("%s does not statically reach dev-only tooling", (name) => {
    const entry = builtPackages.get(name);
    expect(entry).toBeTruthy();
    const reached = reachableSpecifiers(entry as string, builtPackages);

    const leaked = FORBIDDEN_IN_ADAPTERS.filter((forbidden) =>
      [...reached].some(
        (specifier) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
      ),
    );
    expect(leaked).toEqual([]);
  });

  // The native Fetch adapter carries one more promise than the others: it exists so a Bun or Deno
  // production image never loads Express or Node's HTTP shim. That is a claim about its module graph,
  // so it belongs here rather than in a comment.
  it("@skein-js/fetch does not statically reach Express or node:http", () => {
    const entry = builtPackages.get("@skein-js/fetch");
    expect(entry).toBeTruthy();
    const reached = [...reachableSpecifiers(entry as string, builtPackages)];

    expect(reached).not.toContain("express");
    expect(reached).not.toContain("@skein-js/express");
    expect(
      reached.filter((specifier) => specifier === "node:http" || specifier === "http"),
    ).toEqual([]);
  });

  // The walk is only meaningful if it actually crosses package boundaries. Without this, a bug that
  // made `reachableSpecifiers` return early would turn every assertion above into a no-op.
  it("follows workspace edges rather than stopping at the adapter's own file", () => {
    const reached = reachableSpecifiers(
      builtPackages.get("@skein-js/express") as string,
      builtPackages,
    );

    // Reached only by walking express → server-kit → @skein-js/langgraph. (It used to arrive via
    // agent-protocol; that edge is gone — see the assertion below, which is the point of the split.)
    expect([...reached]).toContain("@langchain/langgraph");
  });

  // The claim that makes `@skein-js/agent-protocol` adoptable on its own: serving the Agent Protocol
  // does not require a graph runtime. Every LangGraph value import lives in `@skein-js/langgraph`
  // instead, reached through injected functions (`storeBridge`, `ephemeralCheckpointer`,
  // `cloneCheckpoint`) and the `AgentGraph` the resolver hands back.
  //
  // Asserted on the built entry, because that is what a consumer installs — type-only imports erase,
  // and a `.d.ts` reference does not pull a runtime. If this fails, someone reintroduced a value
  // import and `npm i @skein-js/agent-protocol` silently started requiring LangGraph again.
  it("@skein-js/agent-protocol does not statically reach a graph runtime", () => {
    const entry = builtPackages.get("@skein-js/agent-protocol");
    expect(entry).toBeTruthy();
    const reached = [...reachableSpecifiers(entry as string, builtPackages)];

    const runtimePackages = ["@langchain/langgraph", "@langchain/langgraph-checkpoint"];
    const leaked = runtimePackages.filter((forbidden) =>
      reached.some((specifier) => specifier === forbidden || specifier.startsWith(`${forbidden}/`)),
    );
    expect(leaked).toEqual([]);
  });

  // The *type* graph, which the runtime walk above cannot see. A `import type { … } from
  // "@langchain/langgraph"` erases from the emitted JS but still lands in the generated `.d.ts`, so a
  // consumer who installs only `@skein-js/agent-protocol` would fail to typecheck against an engine
  // that no longer loads a graph runtime. That gap existed and was invisible: the runtime assertion
  // above passed while `dist/index.d.ts` still imported `CompiledGraph`, `BaseCheckpointSaver` and
  // `BaseStore`. Hence a second, separate check.
  it("@skein-js/agent-protocol's public types do not require a graph runtime", () => {
    const entry = builtPackages.get("@skein-js/agent-protocol");
    expect(entry).toBeTruthy();
    const declaration = (entry as string).replace(/\.js$/, ".d.ts");
    expect(existsSync(declaration)).toBe(true);

    // Same matcher the runtime walk uses, so both checks agree on what an import is.
    const imported = staticSpecifiers(declaration);

    expect(imported.filter((specifier) => specifier.startsWith("@langchain/langgraph"))).toEqual(
      [],
    );
  });
});
