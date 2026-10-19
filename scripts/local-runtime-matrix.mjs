// Exercise the existing server matrix with disposable services, without fixed local ports.
import { createRequire } from "node:module";
import { run, root } from "./pack-local-consumer.mjs";
const require = createRequire(
  new URL("../node_modules/testcontainers/package.json", import.meta.url),
);
const { GenericContainer, Wait } = require("testcontainers");
let postgres, redis;
try {
  postgres = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "skein",
      POSTGRES_DB: "skein",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  const env = {
    ...process.env,
    POSTGRES_URI: `postgresql://postgres:skein@${postgres.getHost()}:${postgres.getMappedPort(5432)}/skein`,
    REDIS_URI: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
  };
  for (const runtime of ["node", "bun", "deno"])
    run(
      process.execPath,
      ["packages/test-support/scripts/runtime-conformance.mjs", "--runtime", runtime],
      { cwd: root, env },
    );
} finally {
  await redis?.stop();
  await postgres?.stop();
}
