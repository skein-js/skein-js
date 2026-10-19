import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

const consumerScriptUrl = new URL("../../../scripts/pack-local-consumer.mjs", import.meta.url).href;
const { installConsumer } = await import(consumerScriptUrl);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
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
