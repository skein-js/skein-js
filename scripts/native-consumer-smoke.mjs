import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { GenericContainer, Wait } from "testcontainers";
import { packWorkspace, installConsumer, copyTree, root, run } from "./pack-local-consumer.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "skein-native-consumer-"));
const selectedVersion = (name, fallback) =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const bullmqVersion = selectedVersion("bullmq", "^6.0.0");
const ioredisVersion = selectedVersion("ioredis", "^6.0.0");
let postgres, redis;
try {
  const packed = packWorkspace(path.join(directory, "packs"));
  const consumer = path.join(directory, "consumer");
  const manifest = installConsumer(
    consumer,
    {
      name: "skein-native-proof",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: {
        "@skein-js/local": "*",
        "@skein-js/bullmq": "*",
        "@skein-js/runtime": "*",
        "@skein-js/express": "*",
        "@skein-js/storage-sqlite": "*",
        "@langchain/langgraph": "1.4.12",
        "@langchain/core": "1.2.18",
        bullmq: bullmqVersion,
        ioredis: ioredisVersion,
      },
      devDependencies: { typescript: "^5.7.2", "@types/node": "^22" },
    },
    packed,
  );
  await writeFile(path.join(consumer, "package.json"), JSON.stringify(manifest, null, 2));
  copyTree(path.join(root, "scripts/fixtures/native-consumers"), consumer);
  run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: consumer });
  const consumerRequire = createRequire(path.join(consumer, "package.json"));
  const actualVersions = {};
  for (const [owner, require] of [
    ["consumer", consumerRequire],
    ["@skein-js/bullmq", createRequire(consumerRequire.resolve("@skein-js/bullmq"))],
    [
      "@skein-js/redis",
      createRequire(
        createRequire(consumerRequire.resolve("@skein-js/runtime")).resolve("@skein-js/redis"),
      ),
    ],
  ]) {
    const bull = require("bullmq/package.json").version;
    const redis = require("ioredis/package.json").version;
    for (const [actual, selected] of [
      [bull, bullmqVersion],
      [redis, ioredisVersion],
    ]) {
      if (/^\d+\.\d+\.\d+$/.test(selected) && actual !== selected)
        throw new Error(`Wrong packed version for ${owner}: ${actual}, expected ${selected}`);
      if (selected.startsWith("^") && actual.split(".")[0] !== selected.slice(1).split(".")[0])
        throw new Error(`Wrong packed major for ${owner}: ${actual}`);
    }
    actualVersions[owner] = { bullmq: bull, ioredis: redis };
  }
  console.log("PACKED_REDIS_VERSIONS", JSON.stringify(actualVersions));
  run(
    "npm",
    [
      "exec",
      "--",
      "tsc",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "types.ts",
    ],
    { cwd: consumer },
  );
  run(process.execPath, ["baseline.mjs"], { cwd: consumer });
  run(process.execPath, ["daemon.mjs"], { cwd: consumer });
  [postgres, redis] = await Promise.all([
    new GenericContainer("pgvector/pgvector:pg16")
      .withEnvironment({
        POSTGRES_USER: "skein",
        POSTGRES_PASSWORD: "skein",
        POSTGRES_DB: "skein_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
    new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start(),
  ]);
  run(process.execPath, ["backend.mjs"], {
    cwd: consumer,
    env: {
      ...process.env,
      POSTGRES_URI: `postgresql://skein:skein@${postgres.getHost()}:${postgres.getMappedPort(5432)}/skein_test`,
      REDIS_URI: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    },
  });
} finally {
  await Promise.allSettled([postgres?.stop(), redis?.stop()]);
  await rm(directory, { recursive: true, force: true });
}
