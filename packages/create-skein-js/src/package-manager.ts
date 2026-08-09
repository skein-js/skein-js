// Detecting which package manager invoked us, and running an install with it.

import { spawnSync } from "node:child_process";

import { isPackageManagerName, type PackageManagerName } from "./scaffold-options.js";

/**
 * Which package manager invoked us, from `npm_config_user_agent` — npm, pnpm, yarn and bun all set
 * it to `"<name>/<version> node/<version> …"`. This is what makes `pnpm create skein-js` finish by
 * running `pnpm install` and printing `pnpm dev`, rather than telling a pnpm user to run npm.
 *
 * Takes the user agent as an argument rather than reading `process.env` itself, so it is a pure
 * function of a string and its table of cases is a plain unit test.
 */
export function resolvePackageManager(userAgent: string | undefined): PackageManagerName {
  const name = userAgent?.trim().split("/")[0]?.toLowerCase() ?? "";
  return isPackageManagerName(name) ? name : "npm";
}

/**
 * Install the scaffolded project's dependencies.
 *
 * Returns whether it succeeded rather than throwing: by the time this runs the files are already on
 * disk, so a registry hiccup should downgrade to "run install yourself" in the closing instructions.
 * Deleting a successful scaffold because the network blipped would be the worst possible behaviour.
 */
export function runPackageManagerInstall(
  packageManager: PackageManagerName,
  projectDirectory: string,
): boolean {
  const result = spawnSync(packageManager, ["install"], {
    cwd: projectDirectory,
    stdio: "inherit",
    // On Windows every package manager is a `.cmd` shim, and since the fix for CVE-2024-27980 Node
    // refuses to spawn one without a shell — so `shell: false` there means every Windows scaffold
    // ends in "Install failed." A shell is safe *here* and nowhere else in this file: the only value
    // interpolated is `packageManager`, which `isPackageManagerName` has already narrowed to one of
    // four literals. Nothing user-supplied — no directory name, no project name — reaches this call.
    shell: process.platform === "win32",
  });
  return result.status === 0;
}
