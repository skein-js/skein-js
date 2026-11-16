import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodeModule, { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { sdkMarker } from "@fixture/subpath-sdk/client/index.js";

const [resolverFile, first, second, ordinary] = process.argv.slice(2);
const { resolveInstalledVersion } = await import(pathToFileURL(resolverFile).href);
const issuer = path.join(first, "__skein_resolver__.js");
const require = createRequire(issuer);
assert.ok(process.versions.pnp, "the probe must execute under Yarn PnP");
assert.equal(sdkMarker, "1.32.2");
assert.throws(() => require.resolve("@fixture/subpath-sdk"));
const nestedManifest = require.resolve("@fixture/subpath-sdk/package.json");
assert.match(nestedManifest, /\.zip[\\/]/, "exercise Yarn's archive-backed filesystem");
assert.deepEqual(JSON.parse(readFileSync(nestedManifest, "utf8")), { type: "commonjs" });
assert.throws(() => nodeModule.findPackageJSON("@fixture/hidden", issuer), {
  code: "ERR_MODULE_NOT_FOUND",
});

assert.equal(
  resolveInstalledVersion("@fixture/subpath-sdk", [first, second], nodeModule),
  "1.32.2",
);
assert.equal(resolveInstalledVersion("@fixture/subpath-sdk", [second, first], nodeModule), "9.8.7");
assert.equal(resolveInstalledVersion("@fixture/hidden", [first], nodeModule), "4.5.6");
assert.equal(
  resolveInstalledVersion("@fixture/subpath-sdk", [ordinary, first], nodeModule),
  "3.2.1",
);
assert.throws(() => resolveInstalledVersion("@fixture/unlisted", [first], nodeModule), {
  message: /could not resolve an installed version of "@fixture\/unlisted"/,
});
assert.equal(
  resolveInstalledVersion(
    "@fixture/subpath-sdk",
    [path.join(first, "unrelated"), second],
    nodeModule,
  ),
  "1.32.2",
);
console.log(
  "Yarn PnP: exact root versions, issuer priorities, archive reads and strict dependencies passed.",
);
