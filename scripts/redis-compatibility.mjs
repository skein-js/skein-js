import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { root, run } from "./pack-local-consumer.mjs";

const selected = (name) => {
  const value = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=")[1];
  if (!value || !/^[56]\.\d+\.\d+$/.test(value))
    throw new Error(`--${name}=<exact 5.x or 6.x version> is required`);
  return value;
};
const bullmq = selected("bullmq");
const ioredis = selected("ioredis");
const projects = ["packages/runtime-redis", "packages/bullmq", "examples/native-transports"];
const originals = new Map(
  [...projects.map((project) => `${project}/package.json`), "pnpm-lock.yaml"].map((filename) => [
    filename,
    readFileSync(path.join(root, filename)),
  ]),
);
const reportDirectory = path.join(root, "dist/redis-compatibility");
mkdirSync(reportDirectory, { recursive: true });
const report = {
  node: process.version,
  requested: { bullmq, ioredis },
  resolved: [],
  passed: false,
};
const nx = (...arguments_) =>
  run("pnpm", ["exec", "nx", ...arguments_], {
    cwd: root,
    env: { ...process.env, CI: "true", NX_DAEMON: "false" },
  });
try {
  // Select only the direct dependency owners. Never replace BullMQ 5's own pinned ioredis.
  for (const project of projects) {
    const filename = path.join(root, project, "package.json");
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    manifest.dependencies.bullmq = bullmq;
    manifest.dependencies.ioredis = ioredis;
    writeFileSync(filename, JSON.stringify(manifest, null, 2) + "\n");
  }
  run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root });
  for (const project of projects) {
    const require = createRequire(path.join(root, project, "package.json"));
    const bull = require("bullmq/package.json");
    const redis = require("ioredis/package.json");
    if (bull.version !== bullmq || redis.version !== ioredis)
      throw new Error(`Wrong direct versions in ${project}`);
    const bullRequire = createRequire(require.resolve("bullmq/package.json"));
    const bullClient = bullRequire("ioredis/package.json").version;
    if (bull.dependencies?.ioredis && bullClient !== bull.dependencies.ioredis)
      throw new Error("BullMQ's pinned client was replaced");
    report.resolved.push({
      project,
      bullmq: bull.version,
      ioredis: redis.version,
      bullmqClient: bullClient,
    });
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  nx(
    "run-many",
    "-t",
    "lint",
    "typecheck",
    "test",
    "build",
    "-p",
    "runtime-redis,bullmq,example-native-transports",
    "--parallel=2",
    "--skip-nx-cache",
    "--output-style=stream",
  );
  nx(
    "run-many",
    "-t",
    "test-integration",
    "-p",
    "runtime-redis,bullmq,runtime,example-native-transports",
    "--parallel=2",
    "--skip-nx-cache",
    "--output-style=stream",
  );
  nx(
    "run",
    "test-support:test-native-consumer",
    `--args=--bullmq=${bullmq} --ioredis=${ioredis}`,
    "--skip-nx-cache",
    "--output-style=stream",
  );
  report.passed = true;
} finally {
  writeFileSync(
    path.join(
      reportDirectory,
      `node-${process.versions.node.split(".")[0]}-bullmq-${bullmq}-ioredis-${ioredis}.json`,
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  for (const [filename, contents] of originals) writeFileSync(path.join(root, filename), contents);
  // Also restore installed links, so a local matrix run cannot leave its selected major behind.
  run("pnpm", ["install", "--frozen-lockfile"], { cwd: root });
}
if (!report.passed) throw new Error("Redis compatibility validation did not complete");
process.stdout.write(`REDIS_COMPATIBILITY_OK ${JSON.stringify(report)}\n`);
