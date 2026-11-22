import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { LanggraphJson } from "./langgraph-json.js";
import { parseEnvFile, resolveEnv } from "./resolve-env.js";

const configWith = (env: LanggraphJson["env"]): LanggraphJson =>
  ({ graphs: { agent: "./src/agent.ts:graph" }, env }) as LanggraphJson;

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, skipping blanks and comments", () => {
    expect(parseEnvFile("# comment\n\nFOO=bar\nBAZ=qux\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips a leading `export ` and surrounding quotes", () => {
    expect(parseEnvFile(`export FOO="bar"\nBAZ='qux'`)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("keeps the value's inner `=` and trims surrounding whitespace", () => {
    expect(parseEnvFile("URL = postgres://a=b\n")).toEqual({ URL: "postgres://a=b" });
  });
});

describe("resolveEnv", () => {
  const dirs: string[] = [];

  const makeConfigDir = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "skein-env-"));
    dirs.push(dir);
    return dir;
  };

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns {} when no env field is declared", async () => {
    await expect(resolveEnv(configWith(undefined), "/anywhere")).resolves.toEqual({});
  });

  it("returns an inline map as-is (copied, not shared)", async () => {
    const inline = { OPENAI_API_KEY: "sk-test" };
    const resolved = await resolveEnv(configWith(inline), "/anywhere");
    expect(resolved).toEqual(inline);
    expect(resolved).not.toBe(inline);
  });

  it("reads a `.env` path relative to configDir", async () => {
    const dir = await makeConfigDir();
    await writeFile(path.join(dir, ".env"), "FOO=bar\n");
    await expect(resolveEnv(configWith(".env"), dir)).resolves.toEqual({ FOO: "bar" });
  });

  it("returns {} for a declared-but-missing .env file", async () => {
    const dir = await makeConfigDir();
    await expect(resolveEnv(configWith(".env.missing"), dir)).resolves.toEqual({});
  });
});
