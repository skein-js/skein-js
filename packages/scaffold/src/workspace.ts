import path from "node:path";

import picomatch from "picomatch";
import { subset, validRange } from "semver";
import { parseDocument } from "yaml";
import { z } from "zod";

import { resolveNodeVersion } from "./node-policy.js";
import { buildProjectFiles } from "./project-files.js";
import {
  isPackageManagerName,
  type GeneratedFile,
  type PackageManagerName,
  type ScaffoldOptions,
} from "./scaffold-options.js";

const dependencyMap = z.record(z.string()).optional();
const manifestSchema = z
  .object({
    name: z.string().optional(),
    packageManager: z.string().optional(),
    workspaces: z
      .union([z.array(z.string()), z.object({ packages: z.array(z.string()) }).passthrough()])
      .optional(),
    dependencies: dependencyMap,
    devDependencies: dependencyMap,
    prettier: z.unknown().optional(),
  })
  .passthrough();

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly target: string;
  readonly read: (relativePath: string) => string | undefined;
  readonly packagePaths?: readonly string[];
}

export interface WorkspacePlan {
  readonly packageManager?: PackageManagerName;
  readonly registration?: GeneratedFile;
  readonly registered: boolean;
  readonly nx: boolean;
  readonly options: Pick<ScaffoldOptions, "nodeVersion" | "tooling" | "dependencyVersions">;
  readonly notices: readonly string[];
}

function readManifest(contents: string, filename: string): z.infer<typeof manifestSchema> {
  try {
    return manifestSchema.parse(JSON.parse(contents));
  } catch (error) {
    throw new Error("Invalid workspace metadata in " + filename + ": " + String(error));
  }
}

export function hasWorkspaceMarker(read: WorkspaceSnapshot["read"]): boolean {
  if (
    ["pnpm-workspace.yaml", "nx.json", "turbo.json", "lerna.json"].some(
      (name) => read(name) !== undefined,
    )
  )
    return true;
  const contents = read("package.json");
  return contents !== undefined && readManifest(contents, "package.json").workspaces !== undefined;
}

function matchDirectory(pattern: string, directory: string): boolean {
  return picomatch(pattern.replace(/^\.\//, "").replace(/\/$/, ""), { dot: true })(directory);
}

/** Compute every workspace edit and diagnostic before either entrypoint writes anything. */
export function inspectWorkspace(
  snapshot: WorkspaceSnapshot,
  defaults: ScaffoldOptions,
): WorkspacePlan {
  const { read, target } = snapshot;
  if (!target || target === "." || target.startsWith("../") || path.posix.isAbsolute(target))
    throw new Error("Choose a new project directory inside the workspace.");
  const source = read("package.json");
  if (!source) throw new Error("A workspace root must have package.json.");
  const manifest = readManifest(source, "package.json");
  const yamlSource = read("pnpm-workspace.yaml");
  const document = yamlSource === undefined ? undefined : parseDocument(yamlSource);
  if (document?.errors.length)
    throw new Error("Invalid pnpm-workspace.yaml: " + document.errors.join("; "));
  const yaml = z
    .object({
      packages: z.array(z.string()).optional(),
      catalog: z.record(z.string()).optional(),
      catalogs: z.record(z.record(z.string())).optional(),
    })
    .passthrough()
    .parse(document?.toJS() ?? {});
  const useYaml =
    document && (!manifest.packageManager || manifest.packageManager.startsWith("pnpm@"));
  const patterns = useYaml
    ? (yaml.packages ?? [])
    : Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : (manifest.workspaces?.packages ?? []);
  if (
    patterns.some((pattern) => pattern.startsWith("!") && matchDirectory(pattern.slice(1), target))
  )
    throw new Error("The requested directory is excluded by a workspace pattern: " + target);
  const registered = patterns.some(
    (pattern) => !pattern.startsWith("!") && matchDirectory(pattern, target),
  );
  let registration: GeneratedFile | undefined;
  if (!registered) {
    if (useYaml && document) {
      if (!document.has("packages")) document.set("packages", []);
      document.addIn(["packages"], target);
      registration = { path: "pnpm-workspace.yaml", contents: document.toString() };
    } else {
      const workspaces = Array.isArray(manifest.workspaces)
        ? [...manifest.workspaces, target]
        : manifest.workspaces
          ? { ...manifest.workspaces, packages: [...manifest.workspaces.packages, target] }
          : [target];
      const indentation = source.match(/\n([\t ]+)"/)?.[1] ?? "  ";
      registration = {
        path: "package.json",
        contents: JSON.stringify({ ...manifest, workspaces }, null, indentation) + "\n",
      };
    }
  }
  let packageManager: PackageManagerName | undefined;
  if (manifest.packageManager) {
    if (!/^(npm|pnpm|yarn|bun)@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.packageManager))
      throw new Error("Invalid workspace packageManager: " + manifest.packageManager);
    const name = manifest.packageManager.split("@")[0]!;
    if (!isPackageManagerName(name))
      throw new Error("Unsupported workspace packageManager: " + manifest.packageManager);
    packageManager = name;
  } else {
    packageManager = document
      ? "pnpm"
      : read("yarn.lock") !== undefined
        ? "yarn"
        : read("bun.lock") !== undefined || read("bun.lockb") !== undefined
          ? "bun"
          : read("package-lock.json") !== undefined
            ? "npm"
            : undefined;
  }
  const node = resolveNodeVersion(read(".nvmrc") ?? read(".node-version"));
  const notices = node.notice ? [node.notice] : [];
  const relativeRoot = path.posix.relative(target, ".") || ".";
  const findConfig = (names: readonly string[]) => names.find((name) => read(name) !== undefined);
  const eslintConfig = findConfig([
    "eslint.config.mjs",
    "eslint.config.js",
    "eslint.config.cjs",
    "eslint.config.ts",
    "eslint.config.mts",
    "eslint.config.cts",
  ]);
  if (
    defaults.linting &&
    !eslintConfig &&
    findConfig([
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.yaml",
      ".eslintrc.yml",
    ])
  )
    throw new Error(
      "The workspace uses legacy ESLint configuration. Migrate to flat config or scaffold with --no-linting.",
    );
  const prettierConfig =
    findConfig([
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.yml",
      ".prettierrc.yaml",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
      "prettier.config.ts",
    ]) ?? (manifest.prettier !== undefined ? "package.json" : undefined);
  const relative = (filename: string | undefined) =>
    filename ? path.posix.join(relativeRoot, filename) : undefined;
  const tooling = {
    root: relativeRoot,
    eslintConfig: defaults.linting ? relative(eslintConfig) : undefined,
    prettierConfig: defaults.linting ? relative(prettierConfig) : undefined,
    prettierIgnore: relative(findConfig([".prettierignore"])),
  };
  const baselineManifest = JSON.parse(
    buildProjectFiles(defaults).find((file) => file.path === "package.json")!.contents,
  ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const wanted = { ...baselineManifest.dependencies, ...baselineManifest.devDependencies };
  const rootVersions = { ...manifest.dependencies, ...manifest.devDependencies };
  const siblings = (snapshot.packagePaths ?? [])
    .filter((filename) => {
      const directory = path.posix.dirname(filename);
      return (
        directory !== target &&
        patterns.some(
          (pattern) => !pattern.startsWith("!") && matchDirectory(pattern, directory),
        ) &&
        !patterns.some(
          (pattern) => pattern.startsWith("!") && matchDirectory(pattern.slice(1), directory),
        )
      );
    })
    .map((filename) => readManifest(read(filename)!, filename));
  if (siblings.some((sibling) => sibling.name === defaults.packageName))
    throw new Error("Workspace package name already exists: " + defaults.packageName);
  const dependencyVersions: Record<string, string> = {};
  for (const [name, tested] of Object.entries(wanted)) {
    const rootRange = rootVersions[name];
    const catalogRange = packageManager === "pnpm" ? yaml.catalog?.[name] : undefined;
    const candidates = rootRange
      ? [rootRange]
      : catalogRange
        ? ["catalog:"]
        : [
            ...new Set(
              siblings
                .map((sibling) => sibling.dependencies?.[name] ?? sibling.devDependencies?.[name])
                .filter((range): range is string => range !== undefined),
            ),
          ];
    if (candidates.length !== 1) {
      if (candidates.length > 1)
        notices.push(name + ": sibling ranges disagree; using tested " + tested + ".");
      continue;
    }
    const candidate = candidates[0]!;
    const resolved = candidate.startsWith("catalog:")
      ? candidate === "catalog:"
        ? yaml.catalog?.[name]
        : yaml.catalogs?.[candidate.slice(8)]?.[name]
      : candidate;
    if (resolved && validRange(resolved) && validRange(tested) && subset(resolved, tested))
      dependencyVersions[name] = candidate;
    else
      notices.push(
        name +
          ": workspace range " +
          candidate +
          " differs from tested " +
          tested +
          "; using tested default.",
      );
  }
  return {
    packageManager,
    registration,
    registered,
    nx: read("nx.json") !== undefined,
    options: { nodeVersion: node.version, tooling, dependencyVersions },
    notices,
  };
}
