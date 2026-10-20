import { format } from "prettier";
import { describe, expect, it } from "vitest";

import { inspectWorkspace } from "./workspace.js";
import { buildProjectFiles } from "./project-files.js";

describe("independent inherited tooling", () => {
  it.each(["eslint", "prettier"] as const)(
    "separates %s configuration and dependency ownership",
    (tool) => {
      for (const declared of [false, true]) {
        const config = tool === "eslint" ? "eslint.config.mjs" : ".prettierrc.json";
        const snapshot: Record<string, string> = {
          "package.json": JSON.stringify({
            workspaces: ["apps/*"],
            devDependencies: declared ? { [tool]: "*" } : {},
          }),
          [config]: "{}",
        };
        const defaults = {
          projectName: "agent",
          packageName: "agent",
          provider: "none",
          devStorage: "memory",
          linting: true,
          packageManager: "npm",
          skeinVersionRange: "^0.19.0",
        } as const;
        const plan = inspectWorkspace(
          { root: "/repo", target: "apps/agent", read: (name) => snapshot[name] },
          defaults,
        );
        const files = buildProjectFiles({ ...defaults, ...plan.options });
        const manifest = JSON.parse(files.find((file) => file.path === "package.json")!.contents);
        expect(Boolean(manifest.devDependencies[tool])).toBe(!declared);
        expect(files.some((file) => file.path === config)).toBe(false);
        const helper = files.find((file) => file.path === "scripts/skein-tools.mjs")!.contents;
        expect(helper).toContain(
          (tool === "eslint" ? "rootEslint" : "rootPrettier") + ": " + declared,
        );
      }
    },
  );
  it.each(["eslint", "prettier", "both"] as const)(
    "emits formatted helper for %s",
    async (profile) => {
      const files = buildProjectFiles({
        projectName: "agent",
        packageName: "agent",
        provider: "none",
        devStorage: "memory",
        linting: true,
        packageManager: "yarn",
        skeinVersionRange: "^0.19.0",
        tooling: {
          root: "../..",
          eslintConfig: profile !== "prettier" ? "../../eslint.config.mjs" : undefined,
          prettierConfig: profile !== "eslint" ? "../../.prettierrc.json" : undefined,
        },
      });
      const ignore = files.find((file) => file.path === ".prettierignore")!.contents;
      for (const lockfile of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"])
        expect(ignore).toContain(lockfile);
      const helper = files.find((file) => file.path === "scripts/skein-tools.mjs")!;
      expect(await format(helper.contents, { parser: "babel", printWidth: 100 })).toBe(
        helper.contents,
      );
      expect(files.some((file) => file.path === "eslint.config.mjs")).toBe(profile === "prettier");
      expect(files.some((file) => file.path === ".prettierrc.json")).toBe(profile === "eslint");
    },
  );
});
