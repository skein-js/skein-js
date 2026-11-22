import { basename } from "node:path";

import stylistic from "@stylistic/eslint-plugin";
import { Linter } from "eslint";
import { format } from "prettier";
import { parsers as babelParsers } from "prettier/plugins/babel";
import { parsers as typescriptParsers } from "prettier/plugins/typescript";
import tseslint from "typescript-eslint";

import { codeFiles, spacingRules } from "./code-spacing.mjs";

const linter = new Linter();

const spacingConfig = {
  files: [codeFiles],
  languageOptions: { parser: tseslint.parser },
  plugins: { "@stylistic": stylistic },
  rules: spacingRules,
};

async function applySpacing(text, options) {
  if (options.rangeStart > 0 || options.rangeEnd < text.length) return text;

  // Format first so line wrapping determines which declarations need padding.
  const formatted = await format(text, { ...options, plugins: [], cursorOffset: -1 });

  return linter.verifyAndFix(formatted, spacingConfig, {
    filename: basename(options.filepath ?? "source.ts"),
    allowInlineConfig: false,
  }).output;
}

export const parsers = {
  babel: { ...babelParsers.babel, preprocess: applySpacing },
  typescript: { ...typescriptParsers.typescript, preprocess: applySpacing },
};
