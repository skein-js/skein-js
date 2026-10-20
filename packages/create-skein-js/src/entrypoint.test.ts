import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
function createRoot() {
  const directory = mkdtempSync(path.join(tmpdir(), "skein-entrypoint-"));
  directories.push(directory);
  return directory;
}
function invoke(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, "../dist/index.js"),
      "apps/agent",
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
