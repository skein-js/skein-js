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
    expect(result.stdout).toContain("installation is manual");
    expect(existsSync(path.join(root, "apps/agent/node_modules"))).toBe(false);
  });
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
