import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { buildProjectFiles } from "./project-files.js";
import type { ScaffoldOptions } from "./scaffold-options.js";
import { hasWorkspaceMarker, inspectWorkspace } from "./workspace.js";

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
      listPackagePaths: () => Object.keys(files).filter((name) => name.endsWith("/package.json")),
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
    expect(manifest.devDependencies.eslint).toBeDefined();
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
  it("keeps the root package.json key order when registering", () => {
    const plan = inspect({
      "package.json":
        '{"name":"repo","version":"1.0.0","private":true,"scripts":{"build":"x"},"workspaces":["lib/*"]}',
    });
    expect(Object.keys(JSON.parse(plan.registration!.contents))).toEqual([
      "name",
      "version",
      "private",
      "scripts",
      "workspaces",
    ]);
  });
  it.each(
    [
      ["apps/*", "!apps/private/**"],
      { packages: ["apps/*", "!apps/private/**"], nohoist: ["keep"] },
    ].map((workspaces) => [workspaces] as const),
  )(
    "migrates pnpm workspace patterns without duplicating a covered directory: %j",
    (workspaces) => {
      const files = {
        "package.json": JSON.stringify({ packageManager: "pnpm@9.15.0", workspaces }),
      };
      const before = { ...files };
      const plan = inspect(files);
      expect(plan.registered).toBe(false);
      expect(plan.registration?.path).toBe("pnpm-workspace.yaml");
      expect(parse(plan.registration!.contents)).toEqual({
        packages: ["apps/*", "!apps/private/**"],
      });
      expect(plan.notices.join()).toContain("pnpm ignores package.json workspaces");
      expect(files).toEqual(before);
    },
  );
  it("retains existing packages and exclusions when appending a pnpm workspace registration", () => {
    const plan = inspect({
      "package.json":
        '{"packageManager":"pnpm@9.15.0","workspaces":["packages/*","!apps/private/**"]}',
      "packages/existing/package.json":
        '{"name":"existing","dependencies":{"@langchain/core":"^1.3.0"}}',
    });
    expect(parse(plan.registration!.contents)).toEqual({
      packages: ["packages/*", "!apps/private/**", "apps/agent"],
    });
    expect(plan.options.dependencyVersions?.["@langchain/core"]).toBe("^1.3.0");
  });
  it("rejects migrated pnpm exclusions before writing", () => {
    expect(() =>
      inspect(
        {
          "package.json":
            '{"packageManager":"pnpm@9.15.0","workspaces":["apps/*","!apps/private/**"]}',
        },
        "apps/private/agent",
      ),
    ).toThrow(/excluded/);
  });
  it("detects duplicate package names while migrating pnpm workspace patterns", () => {
    expect(() =>
      inspect({
        "package.json": '{"packageManager":"pnpm@9.15.0","workspaces":["packages/*"]}',
        "packages/existing/package.json": '{"name":"agent"}',
      }),
    ).toThrow(/package name already exists/);
  });
  it("skips sibling manifests that do not parse", () => {
    const plan = inspect({
      "package.json": '{"workspaces":["apps/*"]}',
      "apps/broken/package.json": "{ not json",
      "apps/one/package.json": '{"dependencies":{"@langchain/core":"^1.3.0"}}',
    });
    expect(plan.options.dependencyVersions?.["@langchain/core"]).toBe("^1.3.0");
  });
  it("resolves catalog: through catalogs.default", () => {
    const plan = inspect({
      "package.json": "{}",
      "pnpm-workspace.yaml":
        "packages:\n  - apps/*\ncatalogs:\n  default:\n    typescript: ^5.9.3\n",
    });
    expect(plan.options.dependencyVersions?.typescript).toBe("catalog:");
  });
  it.each([".prettierrc.toml", ".prettierrc.json5", "prettier.config.mts"])(
    "inherits Prettier configured in %s",
    (filename) => {
      const plan = inspect({ "package.json": '{"workspaces":["apps/*"]}', [filename]: "x" });
      expect(plan.options.tooling?.prettierConfig).toBe("../../" + filename);
    },
  );
  it.each([".nvmrc", ".node-version"])("rejects an unsupported pin in %s", (filename) => {
    const files = { "package.json": '{"workspaces":["apps/*"]}', [filename]: "20" };
    const before = { ...files };
    expect(() => inspect(files)).toThrow(/Node pin "20" is unsupported/);
    expect(files).toEqual(before);
  });
});

describe("hasWorkspaceMarker", () => {
  it.each([
    '{"workspaces":"invalid"}',
    '{"workspaces":null}',
    '{"workspaces":["apps/*"],"dependencies":{"broken":123}}',
  ])("detects declared workspaces before validating the root manifest: %s", (manifest) => {
    expect(hasWorkspaceMarker((name) => (name === "package.json" ? manifest : undefined))).toBe(
      true,
    );
  });
  it("walks past a malformed package.json instead of throwing", () => {
    expect(hasWorkspaceMarker((name) => (name === "package.json" ? "{ nope" : undefined))).toBe(
      false,
    );
  });
});
