// A workspace lib reached through the `@fixture/lib` tsconfig-path alias. `skein build` must inline
// this source into the graph bundle (it is not a published npm package).
//
// Its own dependency is installed next to *this lib* and nowhere above it — the pnpm-strict shape:
// `@fixture/lib-dep` is declared on the lib, not on the app, so it is invisible from the app's
// directory. Pinning it can only work if version resolution is anchored at the importing file.
import { libMarker } from "@fixture/lib-dep";

export const BANNER = "from-aliased-workspace-lib";

export function banner(): string {
  return `${BANNER}(${libMarker})`;
}
