# Streaming (SSE)

Skein maps LangGraph.js **stream modes** onto Agent Protocol **Server-Sent Events (SSE)**.
This one transport powers the `/runs/stream` endpoint, joining an in-flight run
(`/runs/{id}/stream`), and thread-scoped streaming (`/threads/{id}/stream`).

Reference: LangGraph streaming — <https://docs.langchain.com/oss/javascript/langgraph/streaming>

## LangGraph.js stream modes

A `CompiledStateGraph.stream(input, { streamMode })` can emit any combination of:

| Mode | Emits |
| --- | --- |
| `values` | Full state after each step |
| `updates` | State deltas per node (**default**) |
| `messages` | Complete messages |
| `messages-tuple` | Message chunk + metadata tuples (token streaming) |
| `custom` | User-emitted custom events |
| `events` | Fine-grained execution events |
| `debug` | Detailed debug info |

Multiple modes can be requested at once; Skein preserves that.

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
  status.
- **Transport ownership** — `@skein/core` produces an async iterator of normalized frames;
  each framework adapter writes them as `text/event-stream` (Express `res.write`, Fastify
  reply stream, etc.). The core stays framework-agnostic.

## Joining and cross-instance fan-out

- `GET /runs/{run_id}/stream` lets a late client join a run already in progress.
- When a run executes on a **different** worker than the one holding the client connection,
  [`@skein/redis`](./runs-and-redis.md) pub/sub fans the frames across instances so the join
  still works. In single-process `skein dev`, an in-memory event bus is used instead.

## Why SSE is enough (no WebSocket in v1)

The entire LangChain client surface — the vanilla SDK, the [`useStream`](./react-sdk.md)
React hook, and Agent Chat UI — consumes **SSE**. The protocol's optional WebSocket upgrade
buys bidirectional framing we don't need for v1, so it is deferred (see
[roadmap.md](./roadmap.md)). **Deferring WebSocket does not affect the React SDK.**
