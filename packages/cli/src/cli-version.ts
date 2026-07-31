// The CLI's own version, read from its `package.json`.
//
// This is legitimate *here* and nowhere else in the workspace: `skein-js` is an application, so it is
// only ever run from its own installed layout. A library must not do this — a bundler rewrites
// `import.meta.url` to the output location and the read breaks (docs/bundling.md), which is why the
// engine takes the version as an injected `ProtocolDeps.serverVersion` instead of reading it.

import { createRequire } from "node:module";

/**
 * Resolved lazily (not at module load) relative to the bundled entry — `dist/index.js` →
 * `../package.json` — which is the layout both the published package and a local build have.
 */
export function skeinCliVersion(): string {
  return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
}
