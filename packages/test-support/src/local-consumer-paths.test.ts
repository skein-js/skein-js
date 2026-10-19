import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const consumerScriptUrl = new URL("../../../scripts/pack-local-consumer.mjs", import.meta.url).href;
const { installConsumer, run } = await import(consumerScriptUrl);
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

it("uses the configured npm CLI with the current Node even when PATH has no npm", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "skein-npm-cli-~ path-"));
  directories.push(directory);
  const entry = path.join(directory, "npm-cli.cjs");
  await writeFile(
    entry,
    "process.stdout.write(JSON.stringify({executable:process.execPath,args:process.argv.slice(2)}));",
  );
  vi.stubEnv("SKEIN_CONSUMER_NPM_CLI", entry);
  const arguments_ = ["install", "file:with space % #/package.tgz"];
  const result = run("npm", arguments_, {
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, PATH: directory, Path: directory },
  });
  expect(JSON.parse(result.stdout)).toEqual({ executable: process.execPath, args: arguments_ });
});

it.each([
  String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\with space % #\local.tgz`,
  "/tmp/RUNNER~1/with space % #/local.tgz",
])("preserves the filesystem path in npm dependency and override specs: %s", async (filename) => {
  const directory = await mkdtemp(path.join(tmpdir(), "skein-consumer-path-test-"));
  directories.push(directory);
  const source = {
    dependencies: { "@skein-js/local": "workspace:*", external: "^1.0.0" },
    devDependencies: { "@skein-js/local": "workspace:*" },
  };
  const packed = { "@skein-js/local": filename };
  const manifest = installConsumer(directory, source, packed);

  expect(manifest.dependencies["@skein-js/local"]).toBe(`file:${filename}`);
  expect(manifest.devDependencies["@skein-js/local"]).toBe(`file:${filename}`);
  expect(manifest.overrides["@skein-js/local"]).toBe(`file:${filename}`);
  expect(manifest.dependencies["external"]).toBe("^1.0.0");
  expect(packed["@skein-js/local"]).toBe(filename);
  expect(source.dependencies["@skein-js/local"]).toBe("workspace:*");
});
