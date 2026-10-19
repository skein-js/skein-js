import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
export const root = path.resolve(import.meta.dirname, "..");
export function run(command, args, options = {}) {
  let executable = command;
  let arguments_ = args;
  if (process.platform === "win32" && ["npm", "pnpm"].includes(command)) {
    // Execute the active tool's JavaScript entry rather than passing paths through cmd.exe.
    const located = spawnSync("where.exe", [`${command}.cmd`], { encoding: "utf8" });
    const shim = located.stdout?.trim().split(/\r?\n/)[0];
    if (!shim) throw new Error(`Cannot locate ${command}.cmd`);
    const directory = path.dirname(shim);
    const entry = command === "npm" ? "bin/npm-cli.js" : "bin/pnpm.cjs";
    const script = [
      path.join(directory, "node_modules", command, entry),
      path.join(directory, "..", command, entry),
    ].find((filename) => existsSync(filename));
    if (!script) throw new Error(`Cannot locate the JavaScript entry for ${command}`);
    executable = process.execPath;
    arguments_ = [script, ...args];
  }
  const result = spawnSync(executable, arguments_, { stdio: "inherit", shell: false, ...options });
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result;
}
export function packWorkspace(directory) {
  mkdirSync(directory, { recursive: true });
  const overrides = {};
  for (const parent of ["packages", "examples"])
    for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const project = path.join(root, parent, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
      } catch {
        continue;
      }
      if (parent === "examples" && entry.name !== "local-workflow") continue;
      if (manifest.private && parent === "packages") continue;
      const result = run("pnpm", ["pack", "--pack-destination", directory], {
        cwd: project,
        stdio: "pipe",
        encoding: "utf8",
      });
      const filename = result.stdout.trim().split(/\r?\n/).at(-1);
      overrides[manifest.name] = path.resolve(project, filename);
    }
  return overrides;
}
export function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}
export function installConsumer(directory, manifest, overrides) {
  mkdirSync(directory, { recursive: true });
  // npm encodes file specs itself. A pre-encoded URL double-encodes characters such as the
  // tilde in Windows' RUNNER~1 temp directory and makes npm open a nonexistent RUNNER%7E1 path.
  const fileOverrides = Object.fromEntries(
    Object.entries(overrides).map(([name, filename]) => [name, `file:${filename}`]),
  );
  const resolveDependencies = (dependencies) =>
    Object.fromEntries(
      Object.entries(dependencies ?? {}).map(([name, version]) => [
        name,
        fileOverrides[name] ?? version,
      ]),
    );
  return {
    ...manifest,
    overrides: fileOverrides,
    dependencies: resolveDependencies(manifest.dependencies),
    ...(manifest.devDependencies
      ? { devDependencies: resolveDependencies(manifest.devDependencies) }
      : {}),
  };
}
