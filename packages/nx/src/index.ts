import path from "node:path";

import {
  addDependenciesToPackageJson,
  addProjectConfiguration,
  getDependencyVersionFromPackageJson,
  getProjects,
  logger,
  NX_VERSION,
  visitNotIgnoredFiles,
  type Tree,
  type TargetConfiguration,
} from "@nx/devkit";
import {
  buildProjectFiles,
  inspectWorkspace,
  formatProjectFiles,
  toPackageName,
  type DevStorage,
  type ModelProvider,
  type ScaffoldOptions,
} from "@skein-js/scaffold";

import { version } from "../package.json";

interface ApplicationOptions {
  readonly directory: string;
  readonly provider?: ModelProvider;
  readonly storage?: DevStorage;
  readonly linting?: boolean;
}

/** Generate an application through Nx's virtual tree; never installs dependencies. */
export async function generateApplication(tree: Tree, options: ApplicationOptions): Promise<void> {
  const hostManifest = tree.read("node_modules/nx/package.json")?.toString();
  const hostVersion: string = hostManifest ? JSON.parse(hostManifest).version : NX_VERSION;
  const [major, minor, patch] = hostVersion.split(".").map(Number);
  if (major !== 23 || minor! < 2 || (minor === 2 && patch! < 1))
    throw new Error("@skein-js/nx supports Nx 23.2.1 through 23.x.");
  if (
    !options.directory ||
    options.directory.includes("\\") ||
    options.directory.split("/").includes("..") ||
    path.posix.isAbsolute(options.directory) ||
    /^[A-Za-z]:/.test(options.directory)
  )
    throw new Error("directory must be a relative directory inside the workspace.");
  const directory = path.posix.normalize(options.directory).replace(/\/$/, "");
  if (directory === "." || directory === "node_modules" || directory.startsWith("node_modules/"))
    throw new Error("Choose a new application directory inside the workspace.");
  if (options.provider && !["none", "google", "anthropic", "openai"].includes(options.provider))
    throw new Error("Unsupported provider.");
  if (options.storage && !["memory", "postgres", "sqlite"].includes(options.storage))
    throw new Error("Unsupported storage.");
  const name = toPackageName(directory.replaceAll("/", "-"));
  const projects = getProjects(tree);
  if (projects.has(name) || [...projects.values()].some((project) => project.root === directory))
    throw new Error("An Nx project already owns this name or directory: " + directory);
  if (tree.children(directory).length)
    throw new Error("Application directory is not empty: " + directory);
  const defaults: ScaffoldOptions = {
    projectName: path.posix.basename(directory),
    packageName: name,
    provider: options.provider ?? "none",
    devStorage: options.storage ?? "memory",
    linting: options.linting ?? true,
    packageManager: "pnpm",
    skeinVersionRange: "^" + version,
  };
  // One walk, only when the workspace has package patterns; inspectWorkspace filters by pattern.
  const listPackagePaths = () => {
    const packagePaths: string[] = [];
    visitNotIgnoredFiles(tree, ".", (filename) => {
      if (filename.endsWith("/package.json")) packagePaths.push(filename);
    });
    return packagePaths;
  };
  const workspace = inspectWorkspace(
    {
      root: tree.root,
      target: directory,
      read: (filename) => tree.read(filename)?.toString(),
      listPackagePaths,
    },
    defaults,
  );
  const base = tree.exists("tsconfig.base.json")
    ? "tsconfig.base.json"
    : tree.exists("tsconfig.json")
      ? "tsconfig.json"
      : undefined;
  if (!base) throw new Error("The Nx workspace needs tsconfig.base.json or tsconfig.json.");
  const resolved: ScaffoldOptions = {
    ...defaults,
    ...workspace.options,
    packageManager: workspace.packageManager ?? "pnpm",
    typescriptBase: path.posix.relative(directory, base),
  };
  const files = buildProjectFiles(resolved);
  const manifestFile = files.find((file) => file.path === "package.json")!;
  const manifest = JSON.parse(manifestFile.contents) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts: Record<string, string>;
  };
  const packageLayout =
    tree.exists("pnpm-workspace.yaml") ||
    JSON.parse(tree.read("package.json")!.toString()).workspaces !== undefined;
  if (!packageLayout) {
    for (const [dependency, required] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      const existingVersion = getDependencyVersionFromPackageJson(tree, dependency);
      if (existingVersion && existingVersion !== required)
        throw new Error(
          "Root dependency " +
            dependency +
            " conflicts with tested " +
            required +
            ". Align the root range before generating.",
        );
    }
  }
  // All validation above is read-only, including dry runs and conflicts.
  for (const file of files) {
    if (file.preserveIfPresent && tree.exists(directory + "/" + file.path)) continue;
    tree.write(
      directory + "/" + file.path,
      file.path === "package.json" && !packageLayout
        ? JSON.stringify(
            { ...manifest, dependencies: undefined, devDependencies: undefined },
            null,
            2,
          ) + "\n"
        : file.contents,
    );
  }
  if (packageLayout && workspace.registration)
    tree.write(workspace.registration.path, workspace.registration.contents);
  if (!packageLayout)
    addDependenciesToPackageJson(
      tree,
      manifest.dependencies ?? {},
      manifest.devDependencies ?? {},
      "package.json",
      true,
    );
  const targets: Record<string, TargetConfiguration> = {};
  for (const [target, command] of Object.entries(manifest.scripts)) {
    targets[target] = {
      executor: "nx:run-commands",
      options: { command, cwd: directory },
      cache: ["build", "typecheck", "test", "lint", "format:check"].includes(target),
      inputs: [
        "^default",
        "{projectRoot}/**/*",
        "!{projectRoot}/.skein/**/*",
        "!{projectRoot}/**/*.{sqlite,sqlite3,db}",
        "!{projectRoot}/**/*.{sqlite,sqlite3,db}-{wal,shm}",
        "{workspaceRoot}/eslint.config.*",
        "{workspaceRoot}/.prettier*",
        "{workspaceRoot}/prettier.config.*",
        "{workspaceRoot}/*lock*",
        "{workspaceRoot}/pnpm-workspace.yaml",
        { runtime: "node --version" },
        "!{projectRoot}/node_modules/**/*",
        "!{projectRoot}/coverage/**/*",
        "{workspaceRoot}/package.json",
        "{workspaceRoot}/" + base,
      ],
      ...(target === "build" ? { outputs: ["{projectRoot}/.skein/build"] } : {}),
      ...(["build", "typecheck", "test"].includes(target) ? { dependsOn: ["^build"] } : {}),
      ...(target === "start" ? { dependsOn: ["build"] } : {}),
    };
  }
  addProjectConfiguration(tree, name, {
    root: directory,
    sourceRoot: directory + "/src",
    projectType: "application",
    targets,
  });
  // Format only this application's generated files; root configuration stays untouched.
  const generated = tree
    .listChanges()
    .flatMap((change) =>
      change.type !== "DELETE" && change.content && change.path.startsWith(directory + "/")
        ? [{ path: change.path.slice(directory.length + 1), contents: change.content.toString() }]
        : [],
    );
  for (const file of await formatProjectFiles(generated, path.join(tree.root, directory)))
    tree.write(directory + "/" + file.path, file.contents);
  for (const notice of workspace.notices) logger.warn(notice);
  logger.info(
    "Generated " + name + ". Run " + resolved.packageManager + " install from the workspace root.",
  );
}
