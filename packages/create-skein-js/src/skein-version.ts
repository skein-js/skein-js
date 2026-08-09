// The version range scaffolded projects pin `skein-js` to.

import { version } from "../package.json";

/**
 * The range a scaffolded project pins `skein-js` and `@skein-js/*` at.
 *
 * `nx release` versions `packages/*` as a *fixed* group, so this package's own version IS the
 * version of the runtime it scaffolds. That identity is what lets us pin an exactly-matching range
 * with no registry lookup and no possibility of drift.
 *
 * The version is read by *importing* `package.json`, not by locating it at runtime. That matters
 * because this package builds to two module formats: an ESM bin and CJS Nx generator factories.
 * `import.meta.url` is unavailable in the CJS output (esbuild leaves it empty and warns), and
 * `__dirname` is unavailable in the ESM output, so any runtime lookup would silently break exactly
 * one of the two entry points. A static import is inlined by the bundler into both.
 *
 * This is safe against the release ordering: .github/workflows/release.yml checks out the tagged
 * commit — which already carries the bumped version — and runs `nx run-many -t build` before
 * publishing, so the value compiled in is the version actually being released.
 */
export function resolveSkeinVersionRange(): string {
  return `^${version}`;
}

/** This package's own version, for `--version`. Same value, unwrapped. */
export const scaffolderVersion: string = version;
