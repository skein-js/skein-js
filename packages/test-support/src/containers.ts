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
export async function startRedis(): Promise<StartedResource> {
  const container = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  return { url, container, stop: () => container.stop().then(() => undefined) };
}
