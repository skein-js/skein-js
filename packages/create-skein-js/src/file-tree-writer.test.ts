import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writeFilesToDisk } from "./file-tree-writer.js";

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "create-skein-js-writer-"));
}

describe("writeFilesToDisk", () => {
  it("creates nested directories", () => {
    const root = temporaryDirectory();
    writeFilesToDisk(root, [{ path: "src/graphs/echo.ts", contents: "export const graph = 1;\n" }]);
    expect(readFileSync(path.join(root, "src/graphs/echo.ts"), "utf8")).toBe(
      "export const graph = 1;\n",
    );
  });

  // `--force` means "scaffold into a directory that has things in it". It must not be readable as
  // permission to replace the credentials already sitting there.
  it("never overwrites an existing file marked preserveIfPresent", () => {
    const root = temporaryDirectory();
    writeFileSync(path.join(root, ".env"), "ANTHROPIC_API_KEY=real-secret\n");

    writeFilesToDisk(root, [
      { path: ".env", contents: "# all commented out\n", preserveIfPresent: true },
    ]);

    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("ANTHROPIC_API_KEY=real-secret\n");
  });

  it("writes a preserveIfPresent file when it is absent", () => {
    const root = temporaryDirectory();
    writeFilesToDisk(root, [{ path: ".env", contents: "# fresh\n", preserveIfPresent: true }]);
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("# fresh\n");
  });

  it.each([
    ["/etc/passwd", "absolute"],
    ["../outside.ts", "escapes the project root"],
  ])("refuses to write %s", (badPath, reason) => {
    const root = temporaryDirectory();
    expect(() => writeFilesToDisk(root, [{ path: badPath, contents: "" }])).toThrow(
      new RegExp(reason),
    );
    expect(existsSync(path.join(root, path.basename(badPath)))).toBe(false);
  });
});
