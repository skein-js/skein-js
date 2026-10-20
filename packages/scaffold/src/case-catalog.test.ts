import { readFileSync } from "node:fs";
import path from "node:path";

import { format } from "prettier";
import { describe, expect, it } from "vitest";

import catalog from "../../../scripts/scaffold-cases.json";

import { buildProjectFiles } from "./project-files.js";
import { MODEL_PROVIDERS, DEV_STORAGES, PACKAGE_MANAGERS } from "./scaffold-options.js";

describe("scaffold case catalog", () => {
  it("covers every option enum and keeps 33 installed cases", () => {
    expect(catalog.providers).toEqual(MODEL_PROVIDERS);
    expect(catalog.storages).toEqual(DEV_STORAGES);
    expect(catalog.packageManagers).toEqual(PACKAGE_MANAGERS);
    expect(catalog.cases).toHaveLength(33);
    expect(new Set(catalog.cases.map((row) => row.id)).size).toBe(33);
  });
  it("covers installed interaction sets", () => {
    const defaults = catalog.cases.filter((row) => row.layout === "standalone" && row.linting);
    const pairs = (
      rows: typeof catalog.cases,
      a: keyof (typeof rows)[number],
      b: keyof (typeof rows)[number],
    ) => new Set(rows.map((row) => row[a] + ":" + row[b]));
    expect(pairs(defaults, "packageManager", "storage").size).toBe(12);
    expect(pairs(defaults, "provider", "storage").size).toBe(12);
    const nx = catalog.cases.filter(
      (row) => row.entry === "nx" && row.linting && row.node !== "26",
    );
    expect(pairs(nx, "layout", "node").size).toBe(4);
    expect(pairs(nx, "layout", "tooling").size).toBe(8);
    expect(pairs(nx, "node", "tooling").size).toBe(8);
    for (const layout of ["integrated", "packages"]) {
      expect(
        new Set(nx.filter((row) => row.layout === layout).map((row) => row.provider)).size,
      ).toBe(4);
      expect(
        new Set(nx.filter((row) => row.layout === layout).map((row) => row.storage)).size,
      ).toBe(3);
    }
  });
  it("adds Node 26 consumers without replacing the Node 22/24 cases", () => {
    const additions = catalog.cases.filter((row) => row.node === "26");
    expect(additions.map((row) => row.id)).toEqual([
      "standalone-pnpm-sqlite-node26",
      "nx-integrated-both-node26",
      "nx-packages-neither-node26",
    ]);
    for (const row of additions) {
      const original = catalog.cases.find(
        (candidate) => candidate.id === row.id.replace(/-node26$/, ""),
      );
      expect(original).toBeDefined();
      expect(row).toEqual({ ...original, id: row.id, node: "26" });
    }
  });
  it("covers each opt-out and workspace group", () => {
    const optOuts = catalog.cases.filter((row) => row.entry === "cli" && !row.linting);
    expect(optOuts).toHaveLength(4);
    expect(new Set(optOuts.map((row) => row.packageManager)).size).toBe(4);
    expect(new Set(optOuts.map((row) => row.provider)).size).toBe(4);
    expect(new Set(optOuts.map((row) => row.storage)).size).toBe(3);
    const workspaces = catalog.cases.filter((row) => row.layout === "workspace");
    expect(workspaces).toHaveLength(4);
    expect(new Set(workspaces.map((row) => row.packageManager)).size).toBe(4);
    expect(new Set(workspaces.map((row) => row.tooling)).size).toBe(4);
    const nxOptOuts = catalog.cases.filter((row) => row.entry === "nx" && !row.linting);
    expect(nxOptOuts).toHaveLength(2);
    expect(new Set(nxOptOuts.map((row) => row.layout)).size).toBe(2);
    expect(nxOptOuts.map((row) => row.tooling).sort()).toEqual(["both", "neither"]);
    expect(new Set(catalog.cases.map((row) => row.node))).toEqual(new Set(["22.12.0", "24", "26"]));
  });
  it("keeps Nx schema defaults and enums aligned with the shared builders", () => {
    const schema = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, "../../nx/src/application-schema.json"),
        "utf8",
      ),
    );
    expect(schema.properties.provider.enum).toEqual(MODEL_PROVIDERS);
    expect(schema.properties.storage.enum).toEqual(DEV_STORAGES);
    expect(schema.properties.linting.default).toBe(true);
  });
  const combinations = MODEL_PROVIDERS.flatMap((provider) =>
    DEV_STORAGES.flatMap((devStorage) =>
      PACKAGE_MANAGERS.flatMap((packageManager) =>
        [false, true].map((linting) => ({ provider, devStorage, packageManager, linting })),
      ),
    ),
  );
  it("has 96 exhaustive generation cases", () => expect(combinations).toHaveLength(96));
  it.each(combinations)(
    "generates $provider/$devStorage/$packageManager/linting=$linting",
    async (options) => {
      const files = buildProjectFiles({
        ...options,
        projectName: "agent",
        packageName: "agent",
        skeinVersionRange: "^0.19.0",
      });
      const manifest = JSON.parse(files.find((file) => file.path === "package.json")!.contents);
      expect(Boolean(manifest.scripts.lint)).toBe(options.linting);
      expect(Boolean(manifest.devDependencies.prettier)).toBe(options.linting);
      expect(files.find((file) => file.path === ".nvmrc")?.contents).toBe("24\n");
      expect(manifest.engines.node).toBe("^22.12.0 || ^24.0.0 || ^26.0.0");
      expect(manifest.scripts.start).toContain("-c .skein/build/langgraph.json");
      expect(new Set(files.map((file) => file.path)).size).toBe(files.length);
      const readme = files.find((file) => file.path === "README.md")!.contents;
      expect(await format(readme, { parser: "markdown", printWidth: 100 })).toBe(readme);
      for (const file of files.filter((file) => file.path.endsWith(".json")))
        expect(() => JSON.parse(file.contents)).not.toThrow();
    },
  );
  it("puts workflow and catalog in the Nx test cache inputs", () => {
    const project = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../project.json"), "utf8"),
    );
    expect(project.targets.test.inputs).toContain("{workspaceRoot}/.github/workflows/ci.yml");
    expect(project.targets.test.inputs).toContain("{workspaceRoot}/scripts/scaffold-cases.json");
  });
});
