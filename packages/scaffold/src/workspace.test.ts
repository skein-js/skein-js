import { describe, expect, it } from "vitest";

import { buildProjectFiles } from "./project-files.js";
import type { ScaffoldOptions } from "./scaffold-options.js";
import { inspectWorkspace } from "./workspace.js";

const defaults: ScaffoldOptions = {
  projectName: "agent",
  packageName: "agent",
  provider: "none",
  devStorage: "memory",
  packageManager: "pnpm",
  linting: true,
  skeinVersionRange: "^0.19.0",
};
function inspect(files: Record<string, string | undefined>, target = "apps/agent") {
  return inspectWorkspace(
    {
      root: "/repo",
      target,
      read: (name) => files[name],
      packagePaths: Object.keys(files).filter((name) => name.endsWith("/package.json")),
    },
    defaults,
  );
}
describe("workspace planning", () => {
  it("preserves YAML comments, globs, exclusions and unrelated configuration", () => {
    const plan = inspect({
      "package.json": "{}",
      "pnpm-workspace.yaml":
        "# keep me\npackages:\n  - libs/*\n  - '!apps/private/**'\ncatalog:\n  typescript: ^5.9.3\n",
    });
    expect(plan.registration?.contents).toContain("# keep me");
    expect(plan.registration?.contents).toContain("libs/*");
    expect(plan.registration?.contents).toContain("!apps/private/**");
    expect(plan.registration?.contents).toContain("apps/agent");
    expect(plan.options.dependencyVersions?.typescript).toBe("catalog:");
    expect(plan.packageManager).toBe("pnpm");
  });
  it("does not register twice when a glob already covers the requested directory", () => {
    expect(inspect({ "package.json": '{"workspaces":["apps/*"]}' }).registration).toBeUndefined();
  });
  it("preserves object-form package workspaces and settings", () => {
    const plan = inspect({
      "package.json":
        '{"workspaces":{"packages":["lib/*"],"nohoist":["x"]},"scripts":{"build":"keep"}}',
    });
    expect(JSON.parse(plan.registration!.contents)).toEqual({
      workspaces: { packages: ["lib/*", "apps/agent"], nohoist: ["x"] },
      scripts: { build: "keep" },
    });
  });
  it.each([
    { "package.json": '{"workspaces":"invalid"}' },
    { "package.json": "{}", "pnpm-workspace.yaml": "packages: [oops" },
    { "package.json": '{"workspaces":["apps/*","!apps/agent"]}' },
    { "package.json": "{}", ".nvmrc": "20" },
  ])("rejects invalid or excluded workspaces before writes", (files) => {
    const before = { ...files };
    expect(() => inspect(files)).toThrow();
    expect(files).toEqual(before);
  });
  it("inherits each tool independently and honors a numeric Node pin", () => {
    const plan = inspect({
      "package.json": "{}",
      ".nvmrc": "22.12.0",
      "eslint.config.mjs": "existing",
    });
    const files = buildProjectFiles({ ...defaults, ...plan.options });
    const manifest = JSON.parse(files.find((file) => file.path === "package.json")!.contents);
    expect(files.some((file) => file.path === "eslint.config.mjs")).toBe(false);
    expect(files.some((file) => file.path === ".prettierrc.json")).toBe(true);
    expect(manifest.devDependencies.eslint).toBeUndefined();
    expect(manifest.devDependencies.prettier).toBeDefined();
    expect(files.find((file) => file.path === ".nvmrc")?.contents).toBe("22.12.0\n");
    expect(
      JSON.parse(files.find((file) => file.path === "langgraph.json")!.contents).node_version,
    ).toBe("22");
  });
  it("reuses unanimous compatible sibling ranges, reports incompatible root ranges", () => {
    const plan = inspect({
      "package.json": '{"workspaces":["apps/*"],"devDependencies":{"vitest":"^3.0.0"}}',
      "apps/one/package.json": '{"dependencies":{"@langchain/core":"^1.3.0"}}',
      "apps/two/package.json": '{"dependencies":{"@langchain/core":"^1.3.0"}}',
    });
    expect(plan.options.dependencyVersions?.["@langchain/core"]).toBe("^1.3.0");
    expect(plan.options.dependencyVersions?.vitest).toBeUndefined();
    expect(plan.notices.join()).toContain("vitest");
  });
});
