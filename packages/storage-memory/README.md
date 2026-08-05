# @skein-js/storage-memory

> In-memory `SkeinStore` + run queue + event bus for development and tests.

Part of **[skein-js](../../README.md)** — the open-source alternative to LangGraph Platform for TypeScript: a self-hosted [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented; passes the shared `SkeinStore` conformance suite.

## What it does

Zero-dependency, in-process drivers that power `skein dev` and back the test fixtures. They
implement the [`@skein-js/core`](../core) contracts, so the engine uses them unchanged:

- **`MemorySkeinStore`** — a `SkeinStore` over plain `Map`s (assistants / threads / runs / store
  items), with the run-concurrency guard, thread→runs cascade delete, and naive prefix/substring
  store search. Every read and write **deep-clones at the boundary** — like a real serializing
  driver — so callers can't mutate stored rows or corrupt the store through a retained reference.
- **`MemoryRunQueue`** — a single-process FIFO of background runs.
- **`MemoryRunEventBus`** — buffered run-frame pub/sub with replay (`afterSeq`) and live-tail, so a
  client can join a run's stream late or reconnect.

Validated against the shared `SkeinStore` conformance suite, so it behaves **identically** to the
Postgres driver — the same tests run against both.

## Install

```bash
pnpm add @skein-js/storage-memory
```

No peer dependencies. Pair it with `MemorySaver` (from `@langchain/langgraph`) as the graph
checkpointer — this package stores only Agent Protocol _resources_, never graph state.

## Usage

Construct with `new` — there is no connect/migrate step:

```ts
import { MemorySkeinStore, MemoryRunQueue, MemoryRunEventBus } from "@skein-js/storage-memory";

const store = new MemorySkeinStore();
const thread = await store.threads.create({ metadata: { user: "a" } });
await store.threads.get(thread.thread_id);
```

Wired into an engine as a full set of in-memory drivers (this is what `skein dev` does):

```ts
import { MemorySaver } from "@langchain/langgraph";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";

const runtime = createProtocolRuntime({
  store: new MemorySkeinStore(),
  queue: new MemoryRunQueue(),
  bus: new MemoryRunEventBus(),
  checkpointer: new MemorySaver(),
  graphs, // a GraphResolver, e.g. from @skein-js/config
});
```

## API

- **`class MemorySkeinStore implements SkeinStore`** —
  `new MemorySkeinStore({ ttl?, threadTtl?, maxPageSize? })`. `ttl` is store-item expiry and
  `threadTtl` is thread expiry (`{ defaultTtl?, sweepIntervalMinutes? }`, minutes) — see
  [docs/storage.md](../../docs/storage.md#thread-ttl). `maxPageSize` (default 1000) bounds every
  list/search, **including one with no `limit`** — see
  [docs/storage.md](../../docs/storage.md#page-bound-skein_max_page_size). Exposes the four
  repos (`assistants`, `threads`, `runs`, `store`) defined by [`SkeinStore`](../core). Plus two
  methods used by `skein dev`'s persistence:
  - `snapshot(): MemoryStoreSnapshot` — serialize all rows.
  - `hydrate(snapshot: MemoryStoreSnapshot): void` — restore a snapshot (used to survive restarts).
- **`interface MemoryStoreSnapshot`** — the serialized form (`assistants` / `threads` / `runs` /
  `runKwargs` / `items` entry arrays).
- **`class MemoryRunQueue implements RunQueue`** — `new MemoryRunQueue()`.
  `enqueue(run)` · `consume(process, options?)` (`options.concurrency` default `1`) → a `RunConsumer`
  with `close(force?)`.
- **`class MemoryRunEventBus implements RunEventBus`** —
  `new MemoryRunEventBus(options?)`. `publish(runId, frame)` · `close(runId)` ·
  `subscribe(runId, afterSeq = 0)`, plus `trackedChannelCount` / `bufferedFrameCount` for diagnostics.

  Options: `maxFramesPerRun` (default `10000`) is a hard maximum on one run's buffer — past it the
  oldest frames go, which ends the stream of any subscriber that had not read them.
  `maxRetainedRuns` (default `50`) is how many finished runs stay replayable for a late join; beyond
  it a run's channel is **deleted**, not blanked, and its id is remembered for `finishedIdTtlMs`
  (default 24h) so the join still completes rather than waiting forever. `now` injects a clock.

  Prefer `resolveMemoryBusLimits()` from [`@skein-js/server-kit`](../server-kit) over hand-passing the
  bounds — it applies `SKEIN_MEMORY_BUS_*` from the environment, which is what every skein-assembled
  runtime does.

See [`@skein-js/core`](../core) for the full `SkeinStore` / `RunQueue` / `RunEventBus` method
signatures these implement.

## Reuse

Pairs with `MemorySaver` (re-exported from `@langchain/langgraph`) for graph checkpoints — it stores
only Agent Protocol _resources_, never graph state.

## Learn more

- [Storage](../../docs/storage.md) · [Runs & Redis](../../docs/runs-and-redis.md)
- [skein-js overview](../../docs/index.md) · [Reuse-first architecture](../../docs/reuse.md) · [Root README](../../README.md)

## License

[Apache-2.0](../../LICENSE)
