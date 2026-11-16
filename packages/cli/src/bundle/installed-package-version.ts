import { readFileSync } from "node:fs";
import type { findPackageJSON } from "node:module";
import path from "node:path";

/** Only the requested package's own metadata can supply its installed version. */
function readVersion(pkgJsonPath: string, pkg: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    } | null;
    return parsed?.name === pkg && typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
}

/** One module tree's answer for a package's installed version, or undefined if it isn't there. */
function findInstalledVersion(
  pkg: string,
  fromDir: string,
  findPackageManifest: typeof findPackageJSON,
): string | undefined {
  try {
    // A bare specifier returns the package root even when its manifest export points into dist/,
    // and does not require a root entrypoint. Resolving a file first would select nested metadata.
    const pkgJsonPath = findPackageManifest(pkg, path.join(fromDir, "__skein_resolver__.js"));
    return pkgJsonPath ? readVersion(pkgJsonPath, pkg) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an installed package's exact version, trying each module tree in order.
 *
 * Node's algorithm walks up from each directory, so one entry covers a project *and* anything hoisted
 * above it. More than one is needed because the two kinds of pinned dependency live in different
 * trees: a graph's imports belong to the **project**, while skein's own runtime peers belong to the
 * **CLI's** tree — under pnpm's strict layout a peer of `skein-js` is not reachable from the project
 * at all. Trying the project first still lets a user pin a peer themselves and have that win.
 */
export function resolveInstalledVersion(
  pkg: string,
  fromDirs: readonly string[],
  findPackageManifest: typeof findPackageJSON,
): string {
  for (const fromDir of fromDirs) {
    const version = findInstalledVersion(pkg, fromDir, findPackageManifest);
    if (version) return version;
  }

  throw new Error(
    `skein build: could not resolve an installed version of "${pkg}". Install it in your project ` +
      `(it is imported by a graph/auth/embed module and must ship in the production image).`,
  );
}
