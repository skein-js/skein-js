import assert from "node:assert/strict";
import { test } from "node:test";

import { ESLint } from "eslint";
import { check, format, resolveConfig } from "prettier";

test("ESLint and Prettier agree on declaration and block spacing", async () => {
  const source = [
    "export const first = 1;",
    "export const second = 2;",
    "export const settings = {",
    "  enabled: true,",
    '  description: "This description keeps the object multiline when Prettier wraps the code.",',
    "};",
    "export const third = 3;",
    "",
    "export function choose() {",
    "  if (first) {",
    "    return second;",
    "  }",
    "  return third;",
    "}",
    "",
  ].join("\n");

  const eslint = new ESLint();

  for (const filepath of ["scripts/spacing-check.mjs", "packages/core/src/spacing-check.ts"]) {
    const options = { ...(await resolveConfig(filepath)), filepath };
    const [before] = await eslint.lintText(source, { filePath: filepath });

    const violations = before.messages.filter(
      (message) => message.ruleId === "@stylistic/padding-line-between-statements",
    );
    assert.equal(violations.length, 3, filepath);
    assert.equal(await check(source, options), false, filepath);

    const formatted = await format(source, options);
    assert.match(formatted, /first = 1;\nexport const second/);
    assert.match(formatted, /second = 2;\n\nexport const settings/);
    assert.match(formatted, /\};\n\nexport const third/);
    assert.ok(formatted.includes("return second;\n  }\n\n  return third;"));
    assert.equal(await check(formatted, options), true, filepath);

    const [after] = await eslint.lintText(formatted, { filePath: filepath });
    assert.equal(after.errorCount, 0, JSON.stringify(after.messages));
  }
});
