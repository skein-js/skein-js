// The fully-resolved description of one scaffolded project. Everything that varies between two
// generated projects lives here, and nothing else does — both entry points (the `npm create` bin and
// the Nx `app` generator) reduce their very different inputs to this one shape before touching a
// template. That is what keeps the two doors from drifting apart.
//
// There is deliberately no "template" or "framework" axis. A scaffolded project is a `langgraph.json`
// driven by the skein CLI — `skein dev` to develop, `skein build` + `skein start` to ship. Mounting
// the engine inside an Express/Fastify/Nest/Next app you already run is a different job with a
// different shape, and it is a documented snippet (docs/using-skein.md) plus a runnable example per
// adapter, not a starter: a scaffolder that emitted one would be generating an app rather than an
// agent.
//
// There is no storage axis either, because the CLI lifecycle already fixes it: `skein dev` runs on
// in-memory drivers with zero setup, and `skein start` is durable-only — it defaults to
// `--store postgres --queue redis` and fails without POSTGRES_URI/REDIS_URI. Every scaffolded
// project therefore ships the compose file that provides them, and the only real choice left is the
// model provider.

/** Which chat model the optional second graph is wired to. `none` emits no model graph at all. */
export type ModelProvider = "none" | "google" | "anthropic" | "openai";

/** Package managers we detect, emit instructions for, and can run an install with. */
export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

export const MODEL_PROVIDERS: readonly ModelProvider[] = ["none", "google", "anthropic", "openai"];
export const PACKAGE_MANAGERS: readonly PackageManagerName[] = ["npm", "pnpm", "yarn", "bun"];

/** Everything a template needs. Fully resolved — no defaults left to apply downstream. */
export interface ScaffoldOptions {
  /** Directory name as the user typed it. Used for prose (the README heading, the closing hint). */
  readonly projectName: string;
  /** npm-legal name written into the generated `package.json`. May differ from `projectName`. */
  readonly packageName: string;
  readonly provider: ModelProvider;
  /** Chosen or detected. Affects the install command and the instructions we print — nothing else. */
  readonly packageManager: PackageManagerName;
  /**
   * The range emitted for `skein-js` and every `@skein-js/*` dependency, e.g. `^0.14.0`. Derived
   * from this package's own version: `nx release` runs a *fixed* group over `packages/*`, so the
   * scaffolder and the runtime it scaffolds always share a version by construction.
   */
  readonly skeinVersionRange: string;
}

/** One file to write. Path is relative to the project root, POSIX-separated, contents newline-terminated. */
export interface GeneratedFile {
  readonly path: string;
  readonly contents: string;
  /**
   * Leave the file alone if it already exists, instead of overwriting it.
   *
   * Set only on `.env`. Every other generated file is ours to own, but a `.env` holds the user's real
   * credentials — and `--force` scaffolds into a directory that already has contents. Overwriting
   * someone's secrets with a file of comments is not something a `--force` flag should be read as
   * permission for.
   */
  readonly preserveIfPresent?: boolean;
}

/**
 * Turn a directory name into a name npm will accept: lowercased, spaces folded to hyphens, and
 * anything outside npm's legal set dropped. A leading `.` or `_` is stripped because npm reserves
 * those, and an empty result falls back to `skein-agent` rather than emitting an invalid manifest.
 *
 * Deliberately *not* silent: the caller compares this against the directory name and tells the user
 * when the two differ, so a renamed package never comes as a surprise later.
 */
export function toPackageName(projectName: string): string {
  const normalized = projectName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-._~]/g, "")
    .replace(/^[._]+/, "");
  return normalized.length > 0 ? normalized : "skein-agent";
}

export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export function isPackageManagerName(value: string): value is PackageManagerName {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}
