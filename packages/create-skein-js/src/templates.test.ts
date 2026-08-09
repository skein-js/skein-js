// Drift guard for the compiled templates, in the spirit of
// packages/storage-postgres/src/migrations.test.ts: editing a `.tmpl` without regenerating should
// fail a test, not ship a starter that silently disagrees with its source.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TEMPLATE_SOURCES } from "./templates.generated.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = path.join(packageRoot, "templates");

async function findTemplateFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await findTemplateFiles(path.join(directory, entry.name), relativePath)));
    } else if (entry.name.endsWith(".tmpl")) {
      found.push(relativePath);
    }
  }
  return found.sort();
}

describe("templates.generated.ts", () => {
  it("matches templates/**/*.tmpl exactly", async () => {
    const templateFiles = await findTemplateFiles(templatesDir);
    expect(templateFiles.length, "expected templates on disk").toBeGreaterThan(0);

    const onDisk = Object.fromEntries(
      await Promise.all(
        templateFiles.map(
          async (file) =>
            [
              file.replace(/\.tmpl$/, ""),
              await readFile(path.join(templatesDir, file), "utf8"),
            ] as const,
        ),
      ),
    );

    expect(
      TEMPLATE_SOURCES,
      "run `nx run create-skein-js:generate-templates` after editing a template",
    ).toEqual(onDisk);
  });
});
