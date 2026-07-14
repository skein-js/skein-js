# Agent Protocol surface

skein-js implements LangChain's [**Agent Protocol**](https://github.com/langchain-ai/agent-protocol),
an OpenAPI-specified, framework-agnostic HTTP + streaming contract for serving LLM agents.

**We reuse rather than redefine the wire types.** The `@langchain/langgraph-sdk` package
already publishes TypeScript types for Thread / Run / Assistant / Store items, and
`@langchain/langgraph-api` publishes the server-side Zod schemas — skein-js builds on those
instead of hand-writing (or regenerating) a parallel set. See [reuse.md](./reuse.md).

## Core resources

| Resource                | Description                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Assistants / agents** | A served graph plus its introspectable input/output/state/config schemas.                                                                                                                                         |
| **Threads**             | Multi-turn conversation containers with persistent state and history; track status (`idle`, `busy`, `interrupted`, `error`).                                                                                      |
| **Runs**                | Atomic executions of a graph — stateless (ephemeral), streaming, or background.                                                                                                                                   |
| **Store**               | Long-term memory organized by namespace + key, with CRUD and (semantic) search. Also injected into graph runs as a LangGraph `BaseStore` — see [storage.md](./storage.md#long-term-memory-in-the-graph-getstore). |
| **Messages**            | First-class primitives aligned with OpenAI/Anthropic formats.                                                                                                                                                     |

## Endpoint inventory

Priority for v1 is marked **✅ MVP**. Deferred items are noted.

### Assistants / agents

| Method | Path                         | MVP |
| ------ | ---------------------------- | --- |
| `POST` | `/agents/search`             |     |
| `GET`  | `/agents/{agent_id}`         |     |
| `GET`  | `/agents/{agent_id}/schemas` | ✅  |

### Threads

| Method   | Path                           | MVP |
| -------- | ------------------------------ | --- |
| `POST`   | `/threads`                     | ✅  |
| `GET`    | `/threads/{thread_id}`         | ✅  |
| `POST`   | `/threads/search`              |     |
| `GET`    | `/threads/{thread_id}/history` |     |
| `PATCH`  | `/threads/{thread_id}`         |     |
| `POST`   | `/threads/{thread_id}/copy`    |     |
| `DELETE` | `/threads/{thread_id}`         | ✅  |

### Runs — stateless / ephemeral

| Method | Path           | MVP |
| ------ | -------------- | --- |
| `POST` | `/runs/wait`   | ✅  |
| `POST` | `/runs/stream` | ✅  |

### Runs — background (thread-scoped)

| Method   | Path                           | MVP |
| -------- | ------------------------------ | --- |
| `POST`   | `/threads/{thread_id}/runs`    | ✅  |
| `GET`    | `/threads/{thread_id}/runs`    |     |
| `GET`    | `/runs/{run_id}`               | ✅  |
| `GET`    | `/runs/{run_id}/wait`          |     |
| `GET`    | `/runs/{run_id}/stream` (join) | ✅  |
| `POST`   | `/runs/{run_id}/cancel`        |     |
| `DELETE` | `/runs/{run_id}`               |     |

### Store (long-term memory)

| Method   | Path                                      | MVP |
| -------- | ----------------------------------------- | --- |
| `PUT`    | `/store/items`                            |     |
| `GET`    | `/store/items`                            |     |
| `DELETE` | `/store/items`                            |     |
| `POST`   | `/store/items/search` (pgvector semantic) | ✅  |
| `POST`   | `/store/namespaces`                       |     |

### Thread streaming (SSE)

| Method | Path                            | MVP |
| ------ | ------------------------------- | --- |
| `POST` | `/threads/{thread_id}/stream`   | ✅  |
| `GET`  | `/threads/{thread_id}/stream`   | ✅  |
| `POST` | `/threads/{thread_id}/commands` | ✅  |

> The protocol also describes a WebSocket upgrade for bidirectional streaming. That is
> **post-MVP** — SSE covers the full client UX (see [streaming.md](./streaming.md)).

## Request/response conventions

- JSON for all non-streaming payloads.
- Request bodies carry `input`, optional `metadata`, optional `config`.
- Responses carry status (`pending` / `success` / `error`), timestamps, and resource IDs.
- Schemas use JSON Schema for interoperability.

## Conformance strategy

The official [`@langchain/langgraph-sdk`](./react-sdk.md) client is our **conformance
oracle**: if `client.threads.create()`, `client.runs.stream()`, and `client.runs.wait()`
are happy against a skein-js server, the wire format is correct. See
[roadmap.md](./roadmap.md#verification) for the full verification plan.

## References

- Agent Protocol repo + OpenAPI — <https://github.com/langchain-ai/agent-protocol>
- aegra's Agent Protocol implementation (Python prior art) — <https://github.com/aegra/aegra>
