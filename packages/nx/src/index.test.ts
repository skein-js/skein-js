import { readJson, readProjectConfiguration } from "@nx/devkit";
import { createTreeWithEmptyWorkspace } from "@nx/devkit/testing";
import { describe, expect, it } from "vitest";

import { version } from "../package.json";

import { generateApplication } from "./index.js";

describe("application generator", () => {
  it.each([false, true])(
    "generates a %s package layout without installation",
    async (packageLayout) => {
      const tree = createTreeWithEmptyWorkspace();
      tree.write("tsconfig.base.json", '{"compilerOptions":{"strict":true}}');
      if (packageLayout) tree.write("pnpm-workspace.yaml", "# retained\npackages:\n  - libs/*\n");
      const before = readJson(tree, "package.json");
      await generateApplication(tree, { directory: "apps/agent", storage: "sqlite" });
      expect(tree.exists("apps/agent/eslint.config.mjs")).toBe(true);
      expect(readJson(tree, "apps/agent/tsconfig.json").extends).toBe("../../tsconfig.base.json");
      const project = readProjectConfiguration(tree, "apps-agent");
      expect(project.targets?.start?.dependsOn).toEqual(["build"]);
      expect(project.targets?.dev?.cache).toBe(false);
      expect(project.targets?.build?.outputs).toEqual(["{projectRoot}/.skein/build"]);
      expect(project.targets?.build?.inputs).toContain("!{projectRoot}/.skein/**/*");
      expect(readJson(tree, "package.json").scripts).toEqual(before.scripts);
      expect(tree.listChanges().every((change) => !change.path.includes("lock"))).toBe(true);
      const manifest = readJson(tree, packageLayout ? "apps/agent/package.json" : "package.json");
      expect(manifest.devDependencies["skein-js"]).toBe("^" + version);
      if (packageLayout)
        expect(tree.read("pnpm-workspace.yaml")?.toString()).toContain("# retained");
    },
  );
  it("supports opt-out and independent inheritance", async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write("tsconfig.base.json", "{}");
    tree.write("eslint.config.mjs", "// keep");
    await generateApplication(tree, { directory: "apps/first" });
    expect(tree.read("eslint.config.mjs")?.toString()).toBe("// keep");
    expect(tree.exists("apps/first/eslint.config.mjs")).toBe(false);
    expect(tree.exists("apps/first/.prettierrc.json")).toBe(true);
    await generateApplication(tree, { directory: "apps/second", linting: false });
    expect(readJson(tree, "apps/second/package.json").scripts.lint).toBeUndefined();
  });
  it.each(["../escape", "/absolute", ".", "apps/../escape"])(
    "rejects %s without mutations",
    async (directory) => {
      const tree = createTreeWithEmptyWorkspace();
      const before = tree.listChanges();
      await expect(generateApplication(tree, { directory })).rejects.toThrow();
      expect(tree.listChanges()).toEqual(before);
    },
  );
  it("rejects a non-empty application directory", async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write("tsconfig.base.json", "{}");
    tree.write("apps/agent/notes.txt", "keep");
    await expect(generateApplication(tree, { directory: "apps/agent" })).rejects.toThrow(
      /not empty/,
    );
  });
  it.each([".nvmrc", ".node-version"])(
    "rejects an unsupported workspace Node pin in %s without mutations",
    async (filename) => {
      const tree = createTreeWithEmptyWorkspace();
      tree.write("tsconfig.base.json", "{}");
      tree.write(filename, "20\n");
      const before = tree.listChanges();
      await expect(generateApplication(tree, { directory: "apps/agent" })).rejects.toThrow(
        /Node pin "20" is unsupported/,
      );
      expect(tree.listChanges()).toEqual(before);
    },
  );
  it("migrates pnpm package patterns while preserving root metadata", async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write("tsconfig.base.json", "{}");
    const manifest =
      '{"packageManager":"pnpm@9.15.0","workspaces":["apps/*","!apps/private/**"],"scripts":{"sentinel":"keep"}}';
    tree.write("package.json", manifest);
    await generateApplication(tree, { directory: "apps/agent" });
    expect(tree.read("pnpm-workspace.yaml")?.toString()).toContain("apps/*");
    expect(tree.read("pnpm-workspace.yaml")?.toString()).toContain("!apps/private/**");
    expect(tree.read("pnpm-workspace.yaml")?.toString()).not.toContain("apps/agent");
    expect(tree.read("package.json")?.toString()).toBe(manifest);
  });
  it("rejects an unsupported host Nx version without mutations", async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write("node_modules/nx/package.json", '{"version":"24.0.0"}');
    const before = tree.listChanges();
    await expect(generateApplication(tree, { directory: "apps/agent" })).rejects.toThrow(/23.2.1/);
    expect(tree.listChanges()).toEqual(before);
  });
  it("rejects root version conflicts without mutations", async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write("tsconfig.base.json", "{}");
    tree.write("package.json", '{"devDependencies":{"vitest":"^3.0.0"}}');
    const before = tree.listChanges();
    await expect(generateApplication(tree, { directory: "apps/agent" })).rejects.toThrow(
      /conflicts/,
    );
    expect(tree.listChanges()).toEqual(before);
  });
});
