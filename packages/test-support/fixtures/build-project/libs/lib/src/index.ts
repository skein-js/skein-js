// Workspace source reached through the `@fixture/lib` tsconfig-path alias. No `node_modules` install
// can supply this — `skein build` has to inline it, which is the whole reason the artifact is bundled
// on the host rather than assembled by a package manager inside the image.

export const BANNER = "built-from-workspace-source";

export function banner(): string {
  return BANNER;
}
