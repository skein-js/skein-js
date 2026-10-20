import { TOOLCHAIN_VERSIONS } from "./dependency-versions.js";
import { renderTemplate } from "./render-template.js";
import type { GeneratedFile, ScaffoldOptions } from "./scaffold-options.js";

export function buildTooling(options: ScaffoldOptions): {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  files: GeneratedFile[];
} {
  if (!options.linting) return { scripts: {}, dependencies: {}, files: [] };
  const files: GeneratedFile[] = [];
  const dependencies: Record<string, string> = {};
  if (!options.tooling?.eslintConfig) {
    files.push({ path: "eslint.config.mjs", contents: renderTemplate("eslint.config.mjs", {}) });
    for (const name of ["eslint", "@eslint/js", "typescript-eslint"] as const)
      dependencies[name] = options.dependencyVersions?.[name] ?? TOOLCHAIN_VERSIONS[name];
  }
  if (!options.tooling?.prettierConfig) {
    files.push({ path: ".prettierrc.json", contents: '{\n  "printWidth": 100\n}\n' });
    dependencies.prettier = options.dependencyVersions?.prettier ?? TOOLCHAIN_VERSIONS.prettier;
  }
  files.push({
    path: ".prettierignore",
    contents:
      "node_modules/\n.skein/\ncoverage/\n.nx/\n.yarn/\n.pnp.*\npackage-lock.json\npnpm-lock.yaml\nyarn.lock\nbun.lock\nbun.lockb\n",
  });
  const inherited = options.tooling?.eslintConfig || options.tooling?.prettierConfig;
  if (inherited)
    files.push({
      path: "scripts/skein-tools.mjs",
      contents: renderTemplate("scripts/skein-tools.mjs", {
        inheritedRoot: options.tooling?.root ?? ".",
        inheritedEslintConfig: options.tooling?.eslintConfig ?? "",
        inheritedPrettierConfig: options.tooling?.prettierConfig ?? "",
        inheritedPrettierIgnore: options.tooling?.prettierIgnore ?? "",
      }),
    });
  return {
    files,
    dependencies,
    scripts: inherited
      ? {
          lint: "node scripts/skein-tools.mjs lint",
          format: "node scripts/skein-tools.mjs format",
          "format:check": "node scripts/skein-tools.mjs check",
        }
      : {
          lint: "eslint src --max-warnings=0",
          format: "prettier --write .",
          "format:check": "prettier --check .",
        },
  };
}
