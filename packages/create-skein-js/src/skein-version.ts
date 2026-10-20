// The version range scaffolded projects pin `skein-js` to.

import { version } from "../package.json";

/**
 * The range a scaffolded project pins `skein-js` and `@skein-js/*` at.
 *
 * `nx release` versions `packages/*` as a *fixed* group, so this package's own version IS the
 * version of the runtime it scaffolds. That identity is what lets us pin an exactly-matching range
 * with no registry lookup and no possibility of drift.
 *
 * Static JSON imports are inlined into the distributed ESM bin. The private shared library
 * supplies templates, while this entrypoint supplies its own release version.
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
