// The seam between "which storage/queue stack is under test" and "what the scenario does to it".
// Scenarios are written once and run against every driver, so a number is always comparable across
// the memory and Postgres+Redis stacks.

import type { Server } from "node:http";

import type { SamplerProbe } from "../harness/sampler.js";

/** A booted skein server the scenario can drive over HTTP. */
export interface BenchServer {
  /** Base URL, e.g. `http://127.0.0.1:41234`. */
  baseUrl: string;
  /** The Node server, so the harness can watch socket buffers. */
  server: Server;
  /** Milliseconds spent assembling deps and binding the port. */
  bootMs: number;
  /**
   * Driver-specific series to sample alongside memory — bus depth, Redis command counts. A driver
   * omits what it cannot measure yet rather than reporting a placeholder, so the report can say
   * `n/a` instead of implying a zero.
   */
  probes: Readonly<Record<string, SamplerProbe>>;
  /** Release everything: worker, server, pools, containers. */
  stop(): Promise<void>;
}

/** Boots a skein server for one scenario run. */
export interface BenchDriver {
  /** Name used in reports and on the command line. */
  readonly name: string;
  /** Whether this driver needs Docker, so the runner can skip it with a clear message. */
  readonly requiresDocker: boolean;
  start(options: BenchDriverStartOptions): Promise<BenchServer>;
}

export interface BenchDriverStartOptions {
  /** The compiled graph to serve, registered under the id `agent`. */
  graph: unknown;
  /** Queued runs the worker executes at once. */
  runConcurrency: number;
}
