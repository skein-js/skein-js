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

Every endpoint below is implemented (✅). The route table in
[`packages/agent-protocol/src/http/routes.ts`](../packages/agent-protocol/src/http/routes.ts) is the
source of truth — paths mirror the `@langchain/langgraph-sdk` client, so runs are addressed
thread-scoped (`/threads/{thread_id}/runs/{run_id}`).

### Assistants

Full CRUD + version history (LangGraph parity). Assistants are auto-registered one-per-graph at
startup (`assistant_id` defaults to `graph_id`), and can also be created/updated/deleted over the
API. Every `PATCH` mints a new **immutable version**; the live row tracks the currently-active
version and mirrors its fields, and `POST .../latest` rolls back to any past version. (Routes use the
`/assistants/...` spelling the `@langchain/langgraph-sdk` client sends — not `/agents/...`.)

| Method   | Path                                          | Notes                                         |
| -------- | --------------------------------------------- | --------------------------------------------- |
| `POST`   | `/assistants`                                 | Create; `if_exists: "raise" \| "do_nothing"`  |
| `GET`    | `/assistants/{assistant_id}`                  |                                               |
| `PATCH`  | `/assistants/{assistant_id}`                  | Update — mints a new version                  |
| `DELETE` | `/assistants/{assistant_id}`                  | `?delete_threads=true` cascades owned threads |
| `POST`   | `/assistants/search`                          | Filter by graph_id/name/metadata; sort + page |
| `POST`   | `/assistants/count`                           | Count matching the search filters             |
| `GET`    | `/assistants/{assistant_id}/schemas`          | Input/output/state/config schemas             |
| `GET`    | `/assistants/{assistant_id}/graph`            | Drawable graph JSON (`?xray`)                 |
| `GET`    | `/assistants/{assistant_id}/subgraphs[/{ns}]` | Subgraph schemas by namespace (`?recurse`)    |
| `POST`   | `/assistants/{assistant_id}/versions`         | Version history, newest-first (filter + page) |
| `POST`   | `/assistants/{assistant_id}/latest`           | Roll back to an existing version              |

### Threads

| Method   | Path                                         | Notes                                         |
| -------- | -------------------------------------------- | --------------------------------------------- |
| `POST`   | `/threads`                                   |                                               |
| `GET`    | `/threads/{thread_id}`                       |                                               |
| `POST`   | `/threads/search`                            |                                               |
| `GET`    | `/threads/{thread_id}/state`                 | Current state snapshot (`useStream` hydrates) |
| `POST`   | `/threads/{thread_id}/state`                 | Time travel: fork state at a checkpoint       |
| `GET`    | `/threads/{thread_id}/state/{checkpoint_id}` | Time travel: state at a checkpoint            |
| `POST`   | `/threads/{thread_id}/history`               | Checkpoint history, newest-first (paged)      |
| `PATCH`  | `/threads/{thread_id}`                       |                                               |
| `POST`   | `/threads/{thread_id}/copy`                  | Duplicates the thread + its history           |
| `DELETE` | `/threads/{thread_id}`                       |                                               |

**Filtering threads by graph.** `POST /threads/search` matches on a metadata subset. When a run is
created, skein stamps the run's `graph_id` and `assistant_id` into the thread's metadata (matching
LangGraph), so listing the threads for a graph is just:

```jsonc
// POST /threads/search
{ "metadata": { "graph_id": "my_graph" } }
```

The stamp reflects the thread's most recent run; a thread that has never run carries no `graph_id`.

**Paging checkpoint history.** `POST /threads/{id}/history` takes its options in the **body** (as the
LangGraph SDK sends them): `{ limit?, before?, metadata? }`. It returns at most **100** checkpoints when
`limit` is omitted, and rejects a `limit` above 1000 — each element is a checkpoint's whole graph state,
so a long thread's full history is one of the largest single responses skein can produce. Page back
through it with `before` (a checkpoint config carrying `checkpoint_id`, or a bare `checkpoint_id`) — the
bound is exclusive, so pass the last checkpoint you received — and narrow it with `metadata`, which
becomes the checkpointer's filter. Only the `checkpoint_id` reaches the checkpointer: the thread scope is
server-owned, so a `thread_id` in `before.configurable` is dropped rather than honoured.

A `?limit=` query param is still accepted for hand-rolled callers, but it is _clamped_ to 1000 rather
than rejected (a query string has no schema to 400 from). The body wins if both are present.

`useStream` sends `limit: 10`, which skein previously **dropped** — it now returns 10 checkpoints instead
of every one, matching LangGraph Platform. The rendered transcript is unaffected (the newest checkpoint's
`values` carry the whole message list); what shrinks is how far back the branch/edit tree reaches. Raise
it by passing your own `limit` if you need deeper history.

The 100-checkpoint default is independent of `SKEIN_MAX_PAGE_SIZE` — history is read from the
checkpointer, not from the store, so the store's page bound does not apply to it.

**Time travel (fork from a checkpoint).** `POST /threads/{id}/history` is read-only, but you can also
_branch_ from any past checkpoint:

- `POST /threads/{id}/state` with `{ values, as_node?, checkpoint_id? }` calls `graph.updateState` to
  write a **new checkpoint** that forks history at `checkpoint_id` (or the tip). It returns the new
  checkpoint pointer, `{ "checkpoint": { "thread_id", "checkpoint_ns", "checkpoint_id" } }`, and mirrors
  the forked values onto the thread row. Rejected with `409` while a run is in flight on the thread.
- `GET /threads/{id}/state/{checkpoint_id}` reads the state snapshot at a specific checkpoint.
- Run creation accepts a top-level **`checkpoint_id`** to start a run from a chosen checkpoint instead
  of the thread tip. This is **server-validated and server-injected** — it is _not_ read from the
  client's `config.configurable` (which strips it), so a client can never redirect a run to an arbitrary
  checkpoint. It rides the LangGraph checkpointer, so no extra storage is involved; thread copy is the
  coarser, whole-history cousin.

### Runs — stateless / ephemeral

| Method | Path           | MVP |
| ------ | -------------- | --- |
| `POST` | `/runs/wait`   | ✅  |
| `POST` | `/runs/stream` | ✅  |

### Runs — background (thread-scoped)

| Method   | Path                                               | Notes                            |
| -------- | -------------------------------------------------- | -------------------------------- |
| `POST`   | `/threads/{thread_id}/runs`                        | Start a background run           |
| `GET`    | `/threads/{thread_id}/runs`                        | List a thread's runs (paginated) |
| `GET`    | `/threads/{thread_id}/runs/{run_id}`               | Fetch one run                    |
| `GET`    | `/threads/{thread_id}/runs/{run_id}/stream` (join) | Join a run's stream              |
| `POST`   | `/threads/{thread_id}/runs/{run_id}/cancel`        | Cancel a run                     |
| `DELETE` | `/threads/{thread_id}/runs/{run_id}`               | Delete a run                     |
| `GET`    | `/runs/{run_id}/stream` (join)                     | Join by run id (thread-agnostic) |

### Store (long-term memory)

| Method   | Path                  | Notes                           |
| -------- | --------------------- | ------------------------------- |
| `PUT`    | `/store/items`        | Upsert an item (optional `ttl`) |
| `GET`    | `/store/items`        | Fetch by namespace + key        |
| `DELETE` | `/store/items`        |                                 |
| `POST`   | `/store/items/search` | pgvector semantic search        |
| `POST`   | `/store/namespaces`   | List namespaces (paginated)     |

**Pagination on these two.** `GET /threads/{thread_id}/runs` takes `?limit`/`?offset` and
`POST /store/namespaces` takes `limit`/`offset` in the body; both default to a **100**-row page, the
same default the SDK sends for `store.listNamespaces`. A query `limit` above 1000 is clamped rather than
rejected, matching every other query-string limit here. Truncation is not signalled on the response
(only assistant search carries `x-pagination-total`), so page until you receive fewer rows than you
asked for. `status` and `select` on `runs.list`, and `suffix`/`max_depth` on `listNamespaces`, are
accepted and **ignored** — they are not implemented yet.

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
- A failed run also carries `error` — a skein extension over the SDK's `Run`, which records only
  _that_ a run failed. See [errors-and-logging.md](./errors-and-logging.md).
- Schemas use JSON Schema for interoperability.

## Authentication + authorization

Auth is **transport-neutral**: it lives in `@skein-js/agent-protocol`, wrapping the handler table
every adapter mounts, so Express, Fastify, NestJS, and Next.js inherit it identically. It's active only
when an `Auth` engine is configured — a `langgraph.json` `auth` block (see
[langgraph-cli-compat.md](./langgraph-cli-compat.md#authentication--authorization-auth)) or an injected
`auth` dep; otherwise the server is unauthenticated.

Per request the wrapper:

1. **Authenticates** — synthesizes a WHATWG `Request` (method, URL, headers) and runs the user's
   `authenticate` handler → an `AuthContext` (`{ user, scopes }`), or `401` if it throws. Studio
   traffic (`x-auth-scheme: langsmith`) is admitted without authenticating unless
   `disable_studio_auth` is set.
2. **Authorizes** — looks up the route's resource + action, runs the matching `@auth.on.*` handler
   (priority: `resource:action` → `resource` → `*:action` → `*`) → `403` on `false`, else ownership
   **filters**.
3. **Dispatches** — through a per-request service carrying the authenticated `user`. When a filter is
   returned, ownership scoping applies to the `threads` family (threads + their runs): a non-owned row
   reads as absent (`404`, never `403`), and the filter's values are stamped onto rows it creates.
   `assistants` and `store` are **gate-only** — their handlers can deny (`403`), but no ownership filter
   is applied yet (graph assistants have no owner and must stay runnable; store items carry no metadata
   to filter on).

**Ownership scoping runs in the database.** A thread search under an ownership filter translates the
filter into a metadata containment clause the driver matches (`metadata @> …` in Postgres, hitting the
`threads_metadata_idx` GIN index), so a request reads only the caller's own rows and `limit`/`offset` page
them directly. It used to read every matching thread — each carrying its full mirrored graph state — and
filter in JS.

The in-process `matchesFilters` check still runs over whatever comes back, and is what actually enforces
ownership: the translation deliberately errs **broad**, leaving out any clause it cannot express exactly
(`{ $eq: "" }` and `{}` constrain nothing, matching the engine), because a clause that were too strict
would silently hide rows a caller owns. `$contains` becomes array containment, which is the same check.

For every filter shape `AuthFilterValue` declares the two agree exactly, so paging an ownership-scoped
search behaves like an unscoped one. A **custom** `AuthEngine` whose `matchesFilters` is stricter than its
own filters is the exception: the in-process check then drops rows the query returned, so pages come back
short and `offset` counts query-matched rather than owned rows. Keep the two consistent, or page by
`offset` until a request returns nothing at all rather than stopping at the first short page.

**Principal in the run config.** The authenticated caller is injected into the graph's `configurable`,
matching LangGraph Platform, so nodes and tools read `config.configurable.langgraph_auth_user` (the
full user), `langgraph_auth_user_id` (its `identity`), and `langgraph_auth_permissions` (its scopes).
These three keys are server-owned and reserved — a client can't spoof them via its own `configurable` —
and are persisted on the run, so a background run resumed on another instance injects the same
principal. With no `auth` configured, no keys are added (identical to `langgraph dev`).

Route → resource/action (runs authorize through their owning thread — there is no `runs` resource):

| Endpoint(s)                                                                                                             | resource\:action                                |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `GET /assistants/{id}`, `/assistants/{id}/schemas`                                                                      | `assistants:read`                               |
| `POST /assistants/search`                                                                                               | `assistants:search`                             |
| `POST /threads`                                                                                                         | `threads:create`                                |
| `GET /threads/{id}`, `/state`, `/state/{checkpoint_id}`; `POST /history`; `GET .../runs`, `.../runs/{run_id}`, run join | `threads:read`                                  |
| `POST /threads/search`                                                                                                  | `threads:search`                                |
| `PATCH /threads/{id}`; `POST /threads/{id}/state` (state fork); run cancel                                              | `threads:update`                                |
| `DELETE /threads/{id}`; run delete                                                                                      | `threads:delete`                                |
| run create (wait/stream/background), thread stream / commands                                                           | `threads:create_run`                            |
| `PUT/GET/DELETE /store/items`, `/store/items/search`, `/store/namespaces`                                               | `store:{put,get,delete,search,list_namespaces}` |

**Reuse & limits.** The `Auth` contract and the `$eq`/`$contains` filter semantics come from
`@langchain/*`; skein adds only the instance-scoped dispatch (see [reuse.md](./reuse.md)). Ownership
scoping is pushed into the driver query (above), with the in-process check kept as the enforcement point.
Per-owner scoping of `assistants`/`store` is still on the [roadmap](./roadmap.md).

## Conformance strategy

The official [`@langchain/langgraph-sdk`](./react-sdk.md) client is our **conformance
oracle**: if `client.threads.create()`, `client.runs.stream()`, and `client.runs.wait()`
are happy against a skein-js server, the wire format is correct. See
[roadmap.md](./roadmap.md#verification) for the full verification plan.

## References

- Agent Protocol repo + OpenAPI — <https://github.com/langchain-ai/agent-protocol>
- aegra's Agent Protocol implementation (Python prior art) — <https://github.com/aegra/aegra>
