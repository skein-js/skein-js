// The production stack: Postgres store + PostgresSaver, Redis queue + cross-instance bus, booted in
// throwaway containers. Reuses the same Testcontainers helpers the integration suites use, so the
// benchmark and the tests agree on what "production drivers" means.

import type { AddressInfo } from "node:net";

import { createExpressServer } from "@skein-js/express";
import { embedPostgresGraphs } from "@skein-js/runtime";
import { startPostgres, startRedis, type StartedResource } from "@skein-js/test-support";

import { trackSocketBuffers } from "../harness/socket-buffer-probe.js";

import type { BenchDriver, BenchServer } from "./bench-driver.js";

export const postgresRedisDriver: BenchDriver = {
  name: "postgres-redis",
  requiresDocker: true,

  async start({ graph, runConcurrency }): Promise<BenchServer> {
    // Containers boot before the timer starts: their startup is Docker's, not skein's, and folding it
    // into `bootMs` would swamp the number this metric exists to track.
    const containers: StartedResource[] = [];
    let postgres: StartedResource;
    let redis: StartedResource;
    try {
      postgres = await startPostgres();
      containers.push(postgres);
      redis = await startRedis();
      containers.push(redis);
    } catch (error) {
      await Promise.allSettled(containers.map((resource) => resource.stop()));
      throw error;
    }

    const bootStartedAt = performance.now();
    const { deps, dispose } = await embedPostgresGraphs(
      { agent: graph as never },
      { postgresUri: postgres.url, redisUri: redis.url },
    );

    const skein = await createExpressServer({
      deps,
      warm: true,
      worker: { maxConcurrency: runConcurrency },
    });
    const server = await skein.listen(0, "127.0.0.1");
    const bootMs = performance.now() - bootStartedAt;

    const sockets = trackSocketBuffers(server);
    const { port } = server.address() as AddressInfo;

    return {
      baseUrl: `http://127.0.0.1:${port}`,
      server,
      bootMs,
      probes: {
        sseBufferedBytes: () => sockets.bufferedBytes(),
        openSockets: () => sockets.openSockets(),
      },
      stop: async () => {
        sockets.stop();
        // Drain before releasing the pools the draining runs still write through — the ordering
        // `docs/deploy.md` calls out for embedded hosts.
        await skein.close();
        await dispose();
        await Promise.allSettled(containers.map((resource) => resource.stop()));
      },
    };
  },
};
