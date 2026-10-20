import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readBakedSchemas } from "./baked-schemas.js";

vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal<typeof fs>();
  return { ...filesystem, statSync: vi.fn(filesystem.statSync) };
});

let root: string;

function writeArtifact(configDir: string): string {
  const artifactDir = path.join(configDir, ".skein", "build");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "langgraph.json"), '{"graphs":{}}');
  fs.writeFileSync(path.join(artifactDir, "schemas.json"), '{"agent":{}}');
  return artifactDir;
}

function missingSchemasError(configDir: string, cwd = root): string {
  try {
    readBakedSchemas(configDir, cwd);
    throw new Error("Expected missing schemas to reject.");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("no schemas.json next to the config");
    return message;
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "skein-baked-schemas-"));
});

afterEach(() => {
  vi.resetAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readBakedSchemas", () => {
  it("suggests selecting the existing build without reading its schemas", () => {
    const artifactDir = writeArtifact(root);
    fs.writeFileSync(path.join(artifactDir, "schemas.json"), "invalid JSON");

    const message = missingSchemasError(root);

    expect(message).toContain(artifactDir);
    expect(message).toContain(
      "Use `-c .skein/build/langgraph.json` in your original `skein start` command",
    );
    expect(message).toContain("keeping its other options");
    expect(message).not.toContain("Run `skein build`");
  });

  it("keeps the generic guidance when there is no build", () => {
    const message = missingSchemasError(root);

    expect(message).toContain("Run `skein build`");
    expect(message).not.toContain("-c ");
  });

  it.each(["langgraph.json", "schemas.json"])(
    "keeps the generic guidance when the build lacks %s",
    (missingFile) => {
      const artifactDir = writeArtifact(root);
      fs.rmSync(path.join(artifactDir, missingFile));

      expect(missingSchemasError(root)).not.toContain("-c ");
    },
  );

  it.each(["langgraph.json", "schemas.json"])(
    "does not suggest a build whose %s is a directory",
    (directoryName) => {
      const artifactDir = writeArtifact(root);
      const directoryPath = path.join(artifactDir, directoryName);
      fs.rmSync(directoryPath);
      fs.mkdirSync(directoryPath);

      expect(missingSchemasError(root)).not.toContain("-c ");
    },
  );

  it("keeps the original diagnostic when inspecting the candidate fails", () => {
    writeArtifact(root);
    vi.mocked(fs.statSync).mockImplementationOnce(() => {
      throw new Error("EACCES: candidate is inaccessible");
    });

    const message = missingSchemasError(root);

    expect(message).toContain("Run `skein build`");
    expect(message).not.toContain("EACCES");
    expect(message).not.toContain("-c ");
  });

  it("looks beside the selected config and formats the command relative to the working directory", () => {
    const configDir = path.join(root, "apps", "agent");
    const artifactDir = writeArtifact(configDir);

    const message = missingSchemasError(configDir);

    expect(message).toContain(artifactDir);
    expect(message).toContain("Use `-c apps/agent/.skein/build/langgraph.json`");
  });

  it("does not suggest an unrelated build in the working directory", () => {
    writeArtifact(root);
    const configDir = path.join(root, "apps", "agent");
    fs.mkdirSync(configDir, { recursive: true });

    expect(missingSchemasError(configDir)).not.toContain("-c ");
  });

  it.each(["my agent", "agent's project", "agent $(printf expanded) `printf expanded`"])(
    "prints a shell-safe config option for %s while keeping the original SQLite flags",
    (directoryName) => {
      const configDir = path.join(root, "apps", directoryName);
      const artifactDir = writeArtifact(configDir);
      const message = missingSchemasError(configDir);
      const configOption = message.match(/Use `(.*)` in your original `skein start` command/)?.[1];
      expect(configOption).toBeDefined();

      const shell = spawnSync(
        "/bin/sh",
        [
          "-c",
          `skein() { printf '%s\\n' "$@"; }\n` +
            `skein start --store sqlite --queue sqlite --sqlite-path 'custom state.sqlite' --port 9000 ${configOption}`,
        ],
        { cwd: root, encoding: "utf8" },
      );

      expect(shell.status).toBe(0);
      expect(shell.stdout.trimEnd().split("\n")).toEqual([
        "start",
        "--store",
        "sqlite",
        "--queue",
        "sqlite",
        "--sqlite-path",
        "custom state.sqlite",
        "--port",
        "9000",
        "-c",
        path.relative(root, path.join(artifactDir, "langgraph.json")),
      ]);
    },
  );

  it("reads the selected artifact even when it has a nested build", () => {
    const artifactDir = writeArtifact(root);
    writeArtifact(artifactDir);
    fs.writeFileSync(path.join(artifactDir, "schemas.json"), '{"selected":{}}');

    expect(readBakedSchemas(artifactDir, root)).toEqual({ selected: {} });
  });

  it("preserves malformed adjacent-schema errors instead of suggesting another build", () => {
    writeArtifact(root);
    fs.writeFileSync(path.join(root, "schemas.json"), "invalid JSON");

    expect(() => readBakedSchemas(root)).toThrow(SyntaxError);
  });

  it("preserves adjacent-schema read errors instead of suggesting another build", () => {
    writeArtifact(root);
    fs.mkdirSync(path.join(root, "schemas.json"));

    expect(() => readBakedSchemas(root)).toThrow(/EISDIR/);
  });
});
