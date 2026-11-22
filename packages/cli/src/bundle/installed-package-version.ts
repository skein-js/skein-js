import { readFileSync } from "node:fs";
import type { findPackageJSON } from "node:module";
import path from "node:path";

interface PnpApi {
  resolveToUnqualified(
    request: string,
    issuer: string,
    options: { considerBuiltins: false },
  ): string | null;
}

/** Yarn extends the CommonJS module object; this is not a named Node export. */
export interface PackageManifestResolvers {
  findPackageJSON: typeof findPackageJSON;
  findPnpApi?: (lookupSource: string) => PnpApi | null;
}

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
  resolvers: PackageManifestResolvers,
): string | undefined {
  try {
    const issuer = path.join(fromDir, "__skein_resolver__.js");
    const pnp = resolvers.findPnpApi?.(issuer);

    if (pnp) {
      // Native lookup bypasses PnP. The unqualified bare request gives the package root without
      // requiring an entrypoint or consulting an exported (possibly nested) package.json.
      const packageRoot = pnp.resolveToUnqualified(pkg, issuer, { considerBuiltins: false });
      return packageRoot ? readVersion(path.join(packageRoot, "package.json"), pkg) : undefined;
    }

    // A bare specifier returns the package root even when its manifest export points into dist/,
    // and does not require a root entrypoint. Resolving a file first would select nested metadata.
    const pkgJsonPath = resolvers.findPackageJSON(pkg, issuer);
    return pkgJsonPath ? readVersion(pkgJsonPath, pkg) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an installed package's exact version, trying each module tree in order.
 *
 * Graph imports belong to the project, while skein's runtime peers may be reachable only from the
 * CLI's tree. A dependency of an inlined workspace library may require its importing file's tree.
 * Callers choose these priorities; a missing or invalid manifest advances to the next tree.
 */
export function resolveInstalledVersion(
  pkg: string,
  fromDirs: readonly string[],
  resolvers: PackageManifestResolvers,
): string {
  for (const fromDir of fromDirs) {
    const version = findInstalledVersion(pkg, fromDir, resolvers);
    if (version) return version;
  }

  throw new Error(
    `skein build: could not resolve an installed version of "${pkg}". Install it in your project ` +
      `(it is imported by a graph/auth/embed module and must ship in the production image).`,
  );
}
