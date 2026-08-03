// Vendor every publishable workspace package into a build context, so an image built from
// *unpublished* sources installs this commit instead of the last release from npm.
//
// Shared by `runtime-image-smoke.mjs` (serving behaviour, three runtimes) and
// `build-image-smoke.mjs` (a real `skein build`, Node only). Extracted so the two cannot drift on the
// one thing that is genuinely fiddly here — see the form trade-off below.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const run = (file, argv, options = {}) =>
  execFileSync(file, argv, { encoding: "utf8", stdio: "pipe", ...options });

/**
 * Vendor every publishable workspace package into `vendorDir`, in the form the target runtime's
 * installer can actually consume. Returns a Map of package name → the entry written under `vendorDir`.
 *
 * **There is no single form that works on all three runtimes**, which is itself a finding worth
 * keeping:
 *
 * - **Tarballs** (`npm`, `bun`): the install drops devDependencies and root `overrides` reach inside,
 *   so the packages resolve each other locally. `deno install` instead symlinks `node_modules/skein-js`
 *   *at the .tgz file*, and the container dies with `Not a directory (os error 20)`.
 * - **Extracted directories** (`deno`): a `file:` directory is treated as a link. npm then installs the
 *   link's devDependencies even under `--omit=dev` (404 on the private `@skein-js/test-support`) and
 *   `overrides` do *not* reach into it (404 on the unpublished `@skein-js/fetch`), so each manifest has
 *   to name its siblings itself. Bun does not follow those relative specs at all.
 *
 * `pnpm pack` rewrites `workspace:*` to a concrete version, which is why either form needs the
 * cross-references repaired — left alone they resolve from the registry.
 */
export function vendorLocalPackages(vendorDir, form) {
  mkdirSync(vendorDir, { recursive: true });
  const vendored = new Map();

  for (const dir of readdirSync(path.join(repoRoot, "packages"))) {
    const manifestPath = path.join(repoRoot, "packages", dir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (manifest.private) continue;

    const before = new Set(readdirSync(vendorDir));
    run("pnpm", ["pack", "--pack-destination", vendorDir], {
      cwd: path.join(repoRoot, "packages", dir),
    });
    const tarball = readdirSync(vendorDir).find((file) => !before.has(file));
    if (!tarball) throw new Error(`pnpm pack produced nothing for ${manifest.name}`);

    if (form === "tarball") {
      vendored.set(manifest.name, tarball);
      continue;
    }
    const target = path.join(vendorDir, path.basename(tarball, ".tgz"));
    mkdirSync(target, { recursive: true });
    // --strip-components=1 drops the `package/` prefix every npm tarball carries.
    run("tar", ["-xzf", path.join(vendorDir, tarball), "-C", target, "--strip-components=1"]);
    rmSync(path.join(vendorDir, tarball));
    vendored.set(manifest.name, path.basename(target));
  }

  if (form === "directory") {
    for (const dir of vendored.values()) {
      const manifestPath = path.join(vendorDir, dir, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest.devDependencies;
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const deps = manifest[field];
        if (!deps) continue;
        for (const name of Object.keys(deps)) {
          const sibling = vendored.get(name);
          if (sibling) deps[name] = `file:../${sibling}`;
        }
      }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }

  return vendored;
}

/**
 * Splice `COPY vendor ./vendor` into a generated Dockerfile, just ahead of its dependency install.
 *
 * The generated Dockerfile installs from `package.json` alone before copying the artifact, so the
 * pinned deps cache independently of the graphs. That layer ordering is right for the real thing —
 * which installs from a registry — but a `file:` spec has to exist at install time. This is the ONE
 * way a smoked image differs from a user's; everything else about it is the generated output verbatim.
 */
export function spliceVendorCopy(dockerfilePath) {
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const anchor = "COPY package.json ./";
  if (!dockerfile.includes(anchor)) {
    throw new Error(`generated Dockerfile no longer contains "${anchor}" — update this splice`);
  }
  writeFileSync(dockerfilePath, dockerfile.replace(anchor, `${anchor}\nCOPY vendor ./vendor`));
}
