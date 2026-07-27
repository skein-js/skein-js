# Streaming (SSE)

Streaming is what makes an agent UI feel alive: tokens appear as the model writes them, model
**thinking** streams into a collapsible panel, tool calls and their **structured results** show up as
they happen, and a paused run's **interrupt** surfaces for approval. skein-js delivers all of it over
one transport — **Server-Sent Events (SSE)** — so the standard clients ([`useStream`](./react-sdk.md),
the vanilla SDK, Agent Chat UI) render a rich conversation against a skein-js server with only a URL
change. The flagship [`chat-app`](../examples/chat-app) example wires the full experience end to end;
[`react-usestream`](../examples/react-usestream) is the minimal harness.

Under the hood, skein-js maps LangGraph.js **stream modes** onto Agent Protocol SSE. This one
transport powers the `/runs/stream` endpoint, joining an in-flight run (`/runs/{id}/stream`), and
thread-scoped streaming (`/threads/{id}/stream`).

Reference: LangGraph streaming — <https://docs.langchain.com/oss/javascript/langgraph/streaming>

## Contents

- [LangGraph.js stream modes](#langgraphjs-stream-modes)
- [Mapping to Agent Protocol SSE](#mapping-to-agent-protocol-sse)
- [Joining and cross-instance fan-out](#joining-and-cross-instance-fan-out)
- [Why SSE is enough (no WebSocket in v1)](#why-sse-is-enough-no-websocket-in-v1)

## LangGraph.js stream modes

A `CompiledStateGraph.stream(input, { streamMode })` can emit any combination of:

| Mode             | Emits                                             |
| ---------------- | ------------------------------------------------- |
| `values`         | Full state after each step                        |
| `updates`        | State deltas per node (**default**)               |
| `messages`       | Complete messages                                 |
| `messages-tuple` | Message chunk + metadata tuples (token streaming) |
| `custom`         | User-emitted custom events                        |
| `events`         | Fine-grained execution events                     |
| `debug`          | Detailed debug info                               |

Multiple modes can be requested at once; skein-js preserves that. When `events` is among the
requested modes the run engine drives the graph via LangGraph's `streamEvents` (v2) and emits each
event as an `events` frame (co-requested modes like `values` still stream alongside); otherwise it
uses `graph.stream`.

## Mapping to Agent Protocol SSE

Each LangGraph stream item becomes an SSE frame:

```
event: <mode>            # e.g. messages, updates, values, custom
id: <monotonic-seq>      # per-run sequence for replay/reconnect
data: <json payload>
```

- **Event id sequencing** — each run assigns monotonically increasing ids so a reconnecting
  client can resume via `Last-Event-ID` (replay support; full replay buffering is iterative).
- **Terminal frames** — a final `event: end` (or `error`) closes the stream with the run's
  status. An `error` frame's payload is a `RunError` — `{ error, message, name, cause?, errors? }`,
  plus `stack` when the server sets `exposeErrorStacks`. See
  [errors-and-logging.md](./errors-and-logging.md).
- **Transport ownership** — `@skein-js/core` produces an async iterator of normalized frames;
  each framework adapter writes them as `text/event-stream` (Express `res.write`, Fastify
  reply stream, etc.). The core stays framework-agnostic.

## Slow clients and backpressure

A stream is only as fast as the client reading it, and skein paces itself accordingly. Every adapter's
write loop honors the response stream's backpressure signal: when the socket's buffer is full it waits
for `drain` before pulling the next frame, rather than queueing whatever the graph produces.

That matters because the alternative is unbounded. A client on a bad connection — a phone on mobile
data, a buffering reverse proxy — that reads more slowly than the graph writes would otherwise be
served entirely out of the server's memory, one full copy of the stream per connection.

Measured in [`packages/bench`](../packages/bench) on the `slow-client` scenario (clients reading at
~25 fps against a 500 fps graph, ~2 MB per stream):

| Concurrent slow streams | Unflushed server-side buffer | Per streaming connection |
| ----------------------- | ---------------------------- | ------------------------ |
| 50, before              | 62.9 MB                      | ~1.26 MB                 |
| 100, before             | 125.5 MB                     | ~1.26 MB                 |
| 50, after               | 3.3 MB                       | ~67 KB                   |
| 100, after              | 6.5 MB                       | ~65 KB                   |

Before, the per-connection cost was the whole stream, so total memory grew with both the number of
clients **and** the length of each run. After, it is a constant close to the socket's own 64 KB
high-water mark: still linear in connection count, as it must be, but no longer proportional to how
much the graph produces.

Two consequences worth knowing:

- **The graph does not slow down.** The run engine publishes into the event bus and the write loop
  reads from it, so pacing the reader changes how fast frames leave the bus, not how fast they enter
  it. A slow client cannot stall the run, or any other client's stream.
- **Frames are not dropped.** Backpressure delays delivery; it never discards. A slow client receives
  every frame, just later.

The Next.js App Router adapter gets this for free: it maps frames onto a `ReadableStream` whose `pull`
is demand-driven by the platform.

## Joining and cross-instance fan-out

- `GET /runs/{run_id}/stream` lets a late client join a run already in progress.
- When a run executes on a **different** worker than the one holding the client connection,
  [`@skein-js/redis`](./runs-and-redis.md) pub/sub fans the frames across instances so the join
  still works. In single-process `skein dev`, an in-memory event bus is used instead.

## Why SSE is enough (no WebSocket in v1)

The entire LangChain client surface — the vanilla SDK, the [`useStream`](./react-sdk.md)
React hook, and Agent Chat UI — consumes **SSE**. The protocol's optional WebSocket upgrade
buys bidirectional framing we don't need for v1, so it is deferred (see
[roadmap.md](./roadmap.md)). **Deferring WebSocket does not affect the React SDK.**
