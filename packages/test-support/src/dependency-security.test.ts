import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

interface BraceNode {
  type: string;
  value?: string;
  nodes?: BraceNode[];
  parent?: BraceNode;
}

interface Braces {
  parse: (pattern: string) => BraceNode;
  compile: (input: string | BraceNode) => string;
  expand: (input: string | BraceNode) => string[];
  stringify: (input: string | BraceNode) => string;
}

const require = createRequire(import.meta.url);
const braces = require("braces") as Braces;
const nestingError = /Input nesting depth exceeds max \(256\)/;

function createNestedAst(depth: number): BraceNode {
  let nested: BraceNode = { type: "text", value: "leaf" };
  for (let index = 0; index < depth; index++) {
    const parent: BraceNode = { type: "paren", nodes: [nested] };
    nested.parent = parent;
    nested = parent;
  }
  const root: BraceNode = { type: "root", nodes: [nested] };
  nested.parent = root;
  return root;
}

// These guard installs of *this workspace* only. Root `pnpm.overrides` and `patchedDependencies` are
// not inherited by applications installing published @skein-js/* packages or Deep Agents; they must
// patch their own lockfiles (docs/audits/dependency-advisories-2026-10-20.md).
describe("braces security patch (GHSA-vfj7-8cjw-p6xm) — workspace installs", () => {
  it("is keyed to the braces version the workspace actually resolves", () => {
    // `patchedDependencies` names an exact version. If a transitive bump resolves another 3.x, pnpm
    // refuses the unused patch on install — this says why, and that the patch must be re-made.
    const rootManifest = require("../../../package.json") as {
      pnpm?: { patchedDependencies?: Record<string, string> };
    };
    const installed = (require("braces/package.json") as { version: string }).version;
    expect(Object.keys(rootManifest.pnpm?.patchedDependencies ?? {})).toContain(
      `braces@${installed}`,
    );
  });

  it.each(["compile", "expand", "stringify", "parse"] as const)(
    "%s rejects deeply nested patterns before recursive traversal",
    (method) => {
      for (const [open, close] of [
        ["{", "}"],
        ["(", ")"],
      ] as const) {
        const pattern = open.repeat(3_000) + "leaf" + close.repeat(3_000);
        expect(() => braces[method](pattern)).toThrow(SyntaxError);
        expect(() => braces[method](pattern)).toThrow(nestingError);
        expect(() => braces[method](open.repeat(3_000))).toThrow(nestingError);
      }
    },
  );

  it.each(["compile", "expand", "stringify"] as const)(
    "%s also bounds AST inputs that bypass the parser",
    (method) => {
      expect(() => braces[method](createNestedAst(3_000))).toThrow(nestingError);
    },
  );

  it("preserves ordinary glob alternatives, ranges, and nested groups", () => {
    expect(braces.compile("src/{api,cli}/index.{ts,js}")).toBe("src/(api|cli)/index.(ts|js)");
    expect(braces.expand("src/{api,cli}/file-{1..3}.ts")).toEqual([
      "src/api/file-1.ts",
      "src/api/file-2.ts",
      "src/api/file-3.ts",
      "src/cli/file-1.ts",
      "src/cli/file-2.ts",
      "src/cli/file-3.ts",
    ]);
    const nested = "(".repeat(200) + "leaf" + ")".repeat(200);
    expect(braces.stringify(braces.parse(nested))).toBe(nested);
  });

  it("does not count escaped, quoted, or character-class delimiters as nesting", () => {
    const literal = "{".repeat(3_000);
    expect(braces.stringify("\\{".repeat(3_000))).toBe(literal);
    expect(braces.stringify(`"${literal}"`)).toBe(literal);
    expect(() => braces.parse("[" + literal + "]")).not.toThrow();
  });
});
