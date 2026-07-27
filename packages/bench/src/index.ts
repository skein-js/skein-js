// @skein-js/bench — private performance benchmarks. Run with `nx bench bench`; see README.md and
// docs/performance.md. This surface exists so the pieces stay importable (and typechecked) as a
// library; `src/main.ts` is the executable entry point.

export type { BenchDriver, BenchDriverStartOptions, BenchServer } from "./drivers/bench-driver.js";
export { memoryDriver } from "./drivers/memory-driver.js";
export { postgresRedisDriver } from "./drivers/postgres-redis-driver.js";
export {
  createTokenStreamGraph,
  type TokenStreamGraphOptions,
} from "./graphs/token-stream-graph.js";
export { peak, percentile } from "./harness/percentiles.js";
export {
  describeEnvironment,
  formatMarkdownTable,
  formatResult,
  writeReport,
  type BenchEnvironment,
  type BenchReport,
} from "./harness/report.js";
export {
  runScenario,
  type RunScenarioOptions,
  type ScenarioResult,
} from "./harness/run-scenario.js";
export {
  forceGarbageCollection,
  MemorySampler,
  type MemoryReading,
  type MemorySamples,
  type MemorySamplerOptions,
} from "./harness/sampler.js";
export { trackSocketBuffers, type SocketBufferProbe } from "./harness/socket-buffer-probe.js";
export {
  createThread,
  streamRun,
  type SseClientOptions,
  type SseClientResult,
} from "./harness/sse-client.js";
export { findScenario, SCENARIOS, type Scenario } from "./scenarios/scenario.js";
export {
  streamRunSlowly,
  type SlowSocketClientOptions,
  type SlowSocketClientResult,
} from "./harness/slow-socket-client.js";
