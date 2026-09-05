// Env resolution for the CLI commands, and specifically the case `skein start` needs.
//
// `skein start` serves a *build*, so its `configDir` is `.skein/build` — and an artifact deliberately
// carries no `.env` of its own (it is the Docker build context, and `skein build` drops a file `env`
// for the same reason). Without a second conventional read, a scaffolded project's own
// `POSTGRES_URI`/`REDIS_URI` were never seen by the one entrypoint that requires them, so
// `npm run build && npm start` failed on a project that looked correctly configured.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LanggraphJson } from "@skein-js/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyProjectEnv } from "./project-env.js";

const config = { graphs: {} } as unknown as LanggraphJson;

let root: string;
let artifact: string;
let KEY: string;
const used: string[] = [];

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "skein-project-env-"));
  artifact = path.join(root, ".skein", "build");
  await mkdir(artifact, { recursive: true });
  // A fresh variable per case. The module remembers which keys *it* set, so that `skein dev`'s
  // reload can correct a value it applied earlier (see `appliedKeys`) — which means a key reused
  // across cases would arrive already marked as skein's own and stop behaving like an ambient one.
  KEY = `SKEIN_PROJECT_ENV_TEST_${used.length}`;
  used.push(KEY);
});

afterEach(() => {
  for (const key of used) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

describe("applyProjectEnv", () => {
  it("reads a .env from the working directory when the config lives elsewhere", async () => {
    writeFileSync(path.join(root, ".env"), `${KEY}=from-the-project\n`);

    await applyProjectEnv(config, artifact, { alsoReadDotEnvIn: root });

    expect(process.env[KEY]).toBe("from-the-project");
  });

  it("does not read the working directory unless asked", async () => {
    // `skein dev` loads a source project, where the config already sits in the directory it would
    // read — opting in per command keeps this from widening what `dev` and `import-langgraph` see.
    writeFileSync(path.join(root, ".env"), `${KEY}=from-the-project\n`);

    await applyProjectEnv(config, artifact);

    expect(process.env[KEY]).toBeUndefined();
  });

  it("ranks the config's own directory above the working directory", async () => {
    // Both exist only when someone has put a `.env` in an artifact deliberately. It is the more
    // specific of the two, so it wins.
    writeFileSync(path.join(root, ".env"), `${KEY}=from-the-project\n`);
    writeFileSync(path.join(artifact, ".env"), `${KEY}=from-the-artifact\n`);

    await applyProjectEnv(config, artifact, { alsoReadDotEnvIn: root });

    expect(process.env[KEY]).toBe("from-the-artifact");
  });

  it("never clobbers the ambient environment", async () => {
    // The dotenv convention, and what the documented `export POSTGRES_URI=… && skein start` relies
    // on: a platform-injected value has to outrank a file that happens to be lying next to the code.
    process.env[KEY] = "from-the-platform";
    writeFileSync(path.join(root, ".env"), `${KEY}=from-the-project\n`);

    await applyProjectEnv(config, artifact, { alsoReadDotEnvIn: root });

    expect(process.env[KEY]).toBe("from-the-platform");
  });

  it("is a no-op when the working directory is the config's directory", async () => {
    // The guard that stops the same file being read and parsed twice.
    writeFileSync(path.join(artifact, ".env"), `${KEY}=from-the-artifact\n`);

    await applyProjectEnv(config, artifact, { alsoReadDotEnvIn: artifact });

    expect(process.env[KEY]).toBe("from-the-artifact");
  });
});
