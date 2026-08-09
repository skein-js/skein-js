// The shared pure core: every file a scaffolded project consists of, as data.
//
// Pure and side-effect-free so it is trivially unit-testable and so both entry points can share it
// verbatim — the `npm create` bin writes the result with node:fs, the Nx generator writes it through
// devkit's virtual Tree. Same split as packages/cli/src/bundle/write-manifest.ts: pure builders
// here, I/O in the caller.
//
// The file *contents* live in ../templates/**.tmpl and are compiled into templates.generated.ts at
// build time. This module is the manifest: which templates make up a project, what they are called
// on disk, and which values they are rendered with. `package.json` is the one exception — it is
// structured data (sorted dependency maps), not text, so it stays a builder.

import { PROVIDER_DETAILS } from "./dependency-versions.js";
import { renderPackageManifest } from "./package-manifest.js";
import { renderTemplate, type TemplateValues } from "./render-template.js";
import type { GeneratedFile, ScaffoldOptions } from "./scaffold-options.js";

/** Spell a script for the chosen package manager (`npm run dev`, but `pnpm dev`). */
function runCommand(options: ScaffoldOptions, script: string): string {
  return options.packageManager === "npm"
    ? `npm run ${script}`
    : `${options.packageManager} ${script}`;
}

/**
 * The values every template is rendered with.
 *
 * Assembled once and passed to all of them, rather than per-template, so that adding a placeholder
 * to a template is a one-line change here — and so `renderTemplate` throwing on an unknown name
 * stays a real signal rather than a routine annoyance.
 */
function templateValuesFor(options: ScaffoldOptions): TemplateValues {
  const provider = options.provider === "none" ? undefined : PROVIDER_DETAILS[options.provider];

  return {
    projectName: options.projectName,
    hasProvider: provider !== undefined,
    // Present but empty when there is no provider: only `{{#if hasProvider}}` blocks read them, and
    // a missing name is an error rather than a blank, which is what catches typos in a template.
    modelClass: provider?.modelClass ?? "",
    modelPackage: provider?.packageName ?? "",
    modelEnvVar: provider?.modelEnvVar ?? "",
    defaultModel: provider?.defaultModel ?? "",
    apiKeyEnvVar: provider?.apiKeyEnvVar ?? "",
    providerConsoleUrl: provider?.consoleUrl ?? "",
    runDev: runCommand(options, "dev"),
    runServices: runCommand(options, "dev:services"),
    runBuild: runCommand(options, "build"),
    runStart: runCommand(options, "start"),
  };
}

/**
 * Every file a scaffolded project consists of, in a stable order.
 *
 * Two calls with equal options return equal arrays; paths are unique, relative, POSIX-separated, and
 * never escape the project root. `project-files.test.ts` asserts all of that for every provider,
 * along with the invariant that matters most: whatever the options, the keyless `echo` graph is
 * present and no emitted file reads a credential.
 */
export function buildProjectFiles(options: ScaffoldOptions): readonly GeneratedFile[] {
  const values = templateValuesFor(options);
  const fromTemplate = (templateKey: string, outputPath: string): GeneratedFile => ({
    path: outputPath,
    contents: renderTemplate(templateKey, values),
  });

  const files: GeneratedFile[] = [
    { path: "package.json", contents: renderPackageManifest(options) },
    fromTemplate("tsconfig.json", "tsconfig.json"),
    fromTemplate("langgraph.json", "langgraph.json"),
    fromTemplate("vitest.config.ts", "vitest.config.ts"),
    // The template is `gitignore.tmpl`, not `.gitignore.tmpl`: npm rewrites a `.gitignore` inside a
    // published tarball, which would silently ship a broken template.
    fromTemplate("gitignore", ".gitignore"),
    fromTemplate("env.example", ".env.example"),
    // The same contents, written twice on purpose. `langgraph.json` points at `.env`, so without it
    // the very first `skein dev` opens with a warning about a missing file — a confusing way to greet
    // someone whose project is working fine. Every line in it is commented out, and `.gitignore`
    // excludes it, so this commits nothing and changes no behaviour.
    { ...fromTemplate("env.example", ".env"), preserveIfPresent: true },
    // Always emitted, not gated behind a flag: `skein start` is durable-only, so without this the
    // `start` script the project ships would be a trap.
    fromTemplate("compose.dev.yaml", "compose.dev.yaml"),
    fromTemplate("README.md", "README.md"),
    fromTemplate("src/echo-graph.ts", "src/echo-graph.ts"),
    fromTemplate("src/echo-graph.test.ts", "src/echo-graph.test.ts"),
  ];

  if (options.provider !== "none") {
    files.push(fromTemplate("src/agent-graph.ts", "src/agent-graph.ts"));
  }

  return files;
}
