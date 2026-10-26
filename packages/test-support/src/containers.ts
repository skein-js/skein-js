import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

/** A booted database/queue container plus its connection URL and a stop() teardown. */
export interface StartedResource {
  url: string;
  container: StartedTestContainer;
  stop: () => Promise<void>;
}

const POSTGRES_IMAGE = "pgvector/pgvector:pg16"; // Postgres + pgvector, matches prod
const REDIS_IMAGE = "redis:7-alpine";

/**
 * Boot a throwaway Postgres (with pgvector) for an integration suite.
 * Call once in `beforeAll`, tear down in `afterAll`. Requires Docker.
 */
export async function startPostgres(): Promise<StartedResource> {
  const user = "skein";
  const password = "skein";
  const database = "skein_test";

  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_USER: user,
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
    })
    .withExposedPorts(5432)
    // Postgres logs the readiness line twice: once on init, once when actually accepting.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgresql://${user}:${password}@${host}:${port}/${database}`;

  return { url, container, stop: () => container.stop().then(() => undefined) };
}

/** Boot a throwaway Redis for an integration suite. Requires Docker. */
export async function startRedis(options: { cluster?: boolean } = {}): Promise<StartedResource> {
  let builder = new GenericContainer(REDIS_IMAGE);
  if (options.cluster)
    builder = builder.withCommand([
      "redis-server",
      "--cluster-enabled",
      "yes",
      "--cluster-config-file",
      "/data/nodes.conf",
      "--cluster-announce-ip",
      "127.0.0.1",
      "--cluster-announce-port",
      "6379",
    ]);
  const container = await builder
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  if (options.cluster) {
    try {
      const assigned = await container.exec([
        "redis-cli",
        "CLUSTER",
        "ADDSLOTSRANGE",
        "0",
        "16383",
      ]);
      if (assigned.exitCode !== 0 || !assigned.output.includes("OK"))
        throw new Error(`Could not assign Redis Cluster slots: ${assigned.output}`);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const state = await container.exec(["redis-cli", "CLUSTER", "INFO"]);
        if (state.output.includes("cluster_state:ok")) break;
        if (Date.now() >= deadline) throw new Error("Redis Cluster did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      await container.stop();
      throw error;
    }
  }

  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  return { url, container, stop: () => container.stop().then(() => undefined) };
}
