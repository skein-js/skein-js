# Agent Protocol surface

skein-js implements LangChain's [**Agent Protocol**](https://github.com/langchain-ai/agent-protocol),
an OpenAPI-specified, framework-agnostic HTTP + streaming contract for serving LLM agents.

**What this gives you:** a standard REST + SSE API your client already speaks — assistants, threads,
runs (wait / stream / background), streaming, interrupts, and a long-term store. Because it's the same
contract LangGraph Platform serves, your existing [`@langchain/langgraph-sdk`](./react-sdk.md) and
[`useStream`](./react-sdk.md) code works against a skein-js server by changing only the URL. You
almost never call these endpoints by hand — the SDK does — but this page is the map of what's
available and what ships in the MVP. For the streaming wire format, see [streaming.md](./streaming.md);
for building a frontend on top, see [react-sdk.md](./react-sdk.md).

## Contents

- [Core resources](#core-resources)
- [Endpoint inventory](#endpoint-inventory)
- [Request/response conventions](#requestresponse-conventions)
- [Authentication + authorization](#authentication--authorization)
- [Conformance strategy](#conformance-strategy)
- [References](#references)

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
| `POST`   | `/threads/search`              | ✅  |
| `GET`    | `/threads/{thread_id}/history` |     |
| `PATCH`  | `/threads/{thread_id}`         |     |
| `POST`   | `/threads/{thread_id}/copy`    | ✅  |
| `DELETE` | `/threads/{thread_id}`         | ✅  |

**Filtering threads by graph.** `POST /threads/search` matches on a metadata subset. When a run is
created, skein stamps the run's `graph_id` and `assistant_id` into the thread's metadata (matching
LangGraph), so listing the threads for a graph is just:

```jsonc
// POST /threads/search
{ "metadata": { "graph_id": "my_graph" } }
```

The stamp reflects the thread's most recent run; a thread that has never run carries no `graph_id`.

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
| `POST`   | `/runs/{run_id}/cancel`        | ✅  |
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

## Authentication + authorization

Auth is **transport-neutral**: it lives in `@skein-js/agent-protocol`, wrapping the handler table
every adapter mounts, so Express / Fastify / Nest inherit it identically. It is active only when a
`langgraph.json` `auth` block loads an `Auth` instance (see
[langgraph-cli-compat.md](./langgraph-cli-compat.md#authentication--authorization-auth)); otherwise the
server is unauthenticated.

Per request the wrapper:

1. **Authenticates** — synthesizes a WHATWG `Request` (method, URL, headers) and runs the user's
   `authenticate` handler → an `AuthContext` (`{ user, scopes }`), or `401` if it throws. Studio
   traffic (`x-auth-scheme: langsmith`) is admitted without authenticating unless
   `disable_studio_auth` is set.
2. **Authorizes** — looks up the route's resource + action, runs the matching `@auth.on.*` handler
   (priority: `resource:action` → `resource` → `*:action` → `*`) → `403` on `false`, else ownership
   **filters**.
3. **Dispatches** — when filters were returned, through a per-request service whose `SkeinStore` is
   an auth-scoped decorator closed over those filters (the shared cancellation registry + thread
   locks are reused; only the store is swapped). The decorator filters reads (a non-owned row reads
   as absent → `404`, never `403`), and stamps the filter's values onto created rows so later reads
   match. It scopes only the `threads` family — threads + their runs (runs inherit their thread's
   owner). `assistants` and `store` are gate-only: their `@auth.on.*` handlers can deny (`403`), but
   no ownership filter is applied — graph assistants are auto-registered with no owner and must stay
   visible to run, and store items carry no metadata to filter on (per-owner scoping of both is a
   Depth-2 follow-up).

Route → resource/action (runs authorize through their owning thread — there is no `runs` resource):

| Endpoint(s)                                                                       | resource\:action                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `GET /assistants/{id}`, `/assistants/{id}/schemas`                                | `assistants:read`                               |
| `POST /assistants/search`                                                         | `assistants:search`                             |
| `POST /threads`                                                                   | `threads:create`                                |
| `GET /threads/{id}`, `/state`, `/history`; `GET .../runs`, `/runs/{id}`, run join | `threads:read`                                  |
| `POST /threads/search`                                                            | `threads:search`                                |
| `PATCH /threads/{id}`; run cancel                                                 | `threads:update`                                |
| `DELETE /threads/{id}`; run delete                                                | `threads:delete`                                |
| run create (wait/stream/background), thread stream / commands                     | `threads:create_run`                            |
| `PUT/GET/DELETE /store/items`, `/store/items/search`, `/store/namespaces`         | `store:{put,get,delete,search,list_namespaces}` |

**Reuse & limits.** The `Auth` contract and the pure `isAuthMatching` filter semantics
(`$eq`/`$contains`) come from `@langchain/*`; skein reimplements only the small, instance-scoped
dispatch (langgraph-api's `registerAuth` is module-global, which skein's DI design avoids). Store
items carry no metadata, so `store:*` handlers can deny/allow but ownership _filtering_ of store
items is deferred; ownership filtering is applied in-process after a fetch (correct at any scale,
with a SQL-pushdown follow-up on the roadmap for large tenants).

## Conformance strategy

The official [`@langchain/langgraph-sdk`](./react-sdk.md) client is our **conformance
oracle**: if `client.threads.create()`, `client.runs.stream()`, and `client.runs.wait()`
are happy against a skein-js server, the wire format is correct. See
[roadmap.md](./roadmap.md#verification) for the full verification plan.

## References

- Agent Protocol repo + OpenAPI — <https://github.com/langchain-ai/agent-protocol>
- aegra's Agent Protocol implementation (Python prior art) — <https://github.com/aegra/aegra>
