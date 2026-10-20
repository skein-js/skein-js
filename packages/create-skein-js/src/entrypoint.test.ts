import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { check, resolveConfig } from "prettier";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
function createRoot() {
  const directory = mkdtempSync(path.join(tmpdir(), "skein-entrypoint-"));
  directories.push(directory);
  return directory;
}
function invoke(root: string, args: string[], target = "apps/agent") {
  return spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, "../dist/index.js"),
      target,
      "--no-install",
      "--no-git",
      ...args,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, CI: "true" } },
  );
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("headless entrypoint", () => {
  it.each(["npm", "pnpm", "nx", "turbo", "lerna"])(
    "rejects the %s workspace root even with --force without writes",
    (kind) => {
      const root = createRoot();
      const manifest = JSON.stringify({
        name: "keep-root",
        ...(kind === "npm" ? { workspaces: ["apps/*"] } : {}),
      });
      writeFileSync(path.join(root, "package.json"), manifest);
      const marker = kind === "pnpm" ? "pnpm-workspace.yaml" : kind + ".json";
      if (kind !== "npm")
        writeFileSync(path.join(root, marker), kind === "pnpm" ? "packages: []\n" : "{}");
      const before = readdirSync(root).sort();
      const result = invoke(root, ["--yes", "--force"], ".");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("root cannot be scaffolded");
      expect(readdirSync(root).sort()).toEqual(before);
      expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(manifest);
    },
  );
  it("formats new files with inherited style without requiring a root Prettier dependency", async () => {
    const root = createRoot();
    const manifest = '{"workspaces":["apps/*"]}';
    const config =
      '{"singleQuote":true,"semi":false,"printWidth":80,"overrides":[{"files":"*.ts","options":{"tabWidth":4}}]}';
    writeFileSync(path.join(root, "package.json"), manifest);
    writeFileSync(path.join(root, ".prettierrc.json"), config);
    const result = invoke(root, ["--yes"]);
    expect(result.status, result.stderr).toBe(0);
    const project = path.join(root, "apps/agent");
    const generated = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
    expect(generated.devDependencies.prettier).toBeDefined();
    expect(existsSync(path.join(project, ".prettierrc.json"))).toBe(false);
    for (const filename of readdirSync(project, { recursive: true })
      .map(String)
      .filter((name) => /\.(ts|mjs|json|md|yaml)$/.test(name)))
      expect(
        await check(readFileSync(path.join(project, filename), "utf8"), {
          filepath: path.join(project, filename),
          ...(await resolveConfig(path.join(project, filename))),
        }),
        filename,
      ).toBe(true);
    expect(readFileSync(path.join(root, ".prettierrc.json"), "utf8")).toBe(config);
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(manifest);
  });
  it.each([[], ["--yes"], ["--linting"], ["--no-linting"]].map((flags) => [flags] as const))(
    "resolves tooling flags %j",
    (flags) => {
      const root = createRoot();
      const result = invoke(root, flags);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(root, "apps/agent/eslint.config.mjs"))).toBe(
        !flags.includes("--no-linting"),
      );
    },
  );
  it.each([false, true])("registers packages unless opted out: %s", (optOut) => {
    const root = createRoot();
    writeFileSync(
      path.join(root, "package.json"),
      '{"private":true,"packageManager":"npm@10.9.2","workspaces":["packages/*"]}',
    );
    const result = invoke(root, optOut ? ["--no-workspace-update"] : ["--yes"]);
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.workspaces.includes("apps/agent")).toBe(!optOut);
    expect(result.stdout).toContain("from the workspace root");
    expect(existsSync(path.join(root, "apps/agent/node_modules"))).toBe(false);
  });
  it.each([
    '{"workspaces":"invalid"}',
    '{"workspaces":null}',
    '{"workspaces":["apps/*"],"dependencies":{"broken":123}}',
  ])("rejects invalid declared workspace metadata without writes: %s", (manifest) => {
    const root = createRoot();
    writeFileSync(path.join(root, "package.json"), manifest);
    const result = invoke(root, ["--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid workspace metadata");
    expect(existsSync(path.join(root, "apps"))).toBe(false);
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(manifest);
  });
  it.each([false, true])("migrates pnpm patterns unless opted out: %s", (optOut) => {
    const root = createRoot();
    const manifest = '{"packageManager":"pnpm@9.15.0","workspaces":["apps/*","!apps/private/**"]}';
    writeFileSync(path.join(root, "package.json"), manifest);
    const result = invoke(root, optOut ? ["--yes", "--no-workspace-update"] : ["--yes"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(!optOut);
    if (!optOut) {
      const registration = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
      expect(registration).toContain("apps/*");
      expect(registration).toContain("!apps/private/**");
      expect(registration).not.toContain("apps/agent");
    }
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(manifest);
  });
  it("rejects a pnpm exclusion before creating its workspace YAML", () => {
    const root = createRoot();
    writeFileSync(
      path.join(root, "package.json"),
      '{"packageManager":"pnpm@9.15.0","workspaces":["apps/*","!apps/agent"]}',
    );
    const result = invoke(root, ["--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("excluded");
    expect(existsSync(path.join(root, "apps"))).toBe(false);
    expect(existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(false);
  });
  it.each([".nvmrc", ".node-version"])(
    "rejects an unsupported Node pin in %s before writing",
    (filename) => {
      const root = createRoot();
      writeFileSync(path.join(root, "package.json"), '{"workspaces":["apps/*"]}');
      writeFileSync(path.join(root, filename), "20\n");
      const result = invoke(root, ["--yes"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Node pin "20" is unsupported');
      expect(existsSync(path.join(root, "apps"))).toBe(false);
      expect(readFileSync(path.join(root, filename), "utf8")).toBe("20\n");
    },
  );
  it("redirects Nx before writing files", () => {
    const root = createRoot();
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(path.join(root, "nx.json"), "{}");
    const result = invoke(root, ["--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@skein-js/nx:application");
    expect(existsSync(path.join(root, "apps"))).toBe(false);
  });
  it("fails invalid metadata and manager conflicts without writes", () => {
    const root = createRoot();
    writeFileSync(
      path.join(root, "package.json"),
      '{"workspaces":["apps/*"],"packageManager":"pnpm@9.15.0"}',
    );
    const result = invoke(root, ["--pm", "npm", "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("conflicts");
    expect(existsSync(path.join(root, "apps"))).toBe(false);
  });
});
