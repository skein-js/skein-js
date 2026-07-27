// The zero-infrastructure driver: in-process store, queue, bus, and checkpointer. Runs anywhere with
// no Docker, which is what makes it usable as a required PR check.

import type { AddressInfo } from "node:net";

import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { MemoryRunEventBus } from "@skein-js/storage-memory";

import type { SamplerProbe } from "../harness/sampler.js";
import { trackSocketBuffers } from "../harness/socket-buffer-probe.js";

import type { BenchDriver, BenchServer } from "./bench-driver.js";

/**
 * Bus diagnostics arrived with the bounding work; before it, the accessors simply are not there.
 * Duck-type rather than version-check so the benchmark runs unchanged against both a pre-fix baseline
 * and a post-fix build — the report renders the missing series as `n/a`.
 */
interface BusDiagnostics {
  bufferedFrameCount?: number;
  trackedChannelCount?: number;
}

function busProbes(bus: MemoryRunEventBus): Record<string, SamplerProbe> {
  const diagnostics = bus as unknown as BusDiagnostics;
  const probes: Record<string, SamplerProbe> = {};
  if (typeof diagnostics.bufferedFrameCount === "number") {
    probes["busBufferedFrames"] = () => (bus as unknown as BusDiagnostics).bufferedFrameCount ?? 0;
  }
  if (typeof diagnostics.trackedChannelCount === "number") {
    probes["busTrackedChannels"] = () =>
      (bus as unknown as BusDiagnostics).trackedChannelCount ?? 0;
  }
  return probes;
}

export const memoryDriver: BenchDriver = {
  name: "memory",
  requiresDocker: false,

  async start({ graph, runConcurrency }): Promise<BenchServer> {
    const bootStartedAt = performance.now();

    // Constructed here rather than left to `embedInMemoryGraphs` so the harness holds a reference to
    // probe. Everything else stays at the helper's defaults, which is what a user would get.
    const bus = new MemoryRunEventBus();
    const deps = embedInMemoryGraphs({ agent: graph as never }, { bus });

    const skein = await createExpressServer({
      deps,
      warm: true,
      worker: { maxConcurrency: runConcurrency },
    });
    // Port 0: the OS picks a free one, so parallel scenario runs never collide on a fixed port.
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
        ...busProbes(bus),
      },
      stop: async () => {
        sockets.stop();
        await skein.close();
      },
    };
  },
};
