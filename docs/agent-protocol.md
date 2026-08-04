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
- [Crons (LangGraph Platform extension)](#crons-langgraph-platform-extension)
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
| **Crons**               | Schedules that fire a run on a cadence. A LangGraph Platform extension, not part of the open spec — see [crons.md](./crons.md).                                                                                   |
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
| `POST`   | `/threads`                                   | Create; `if_exists: "raise" \| "do_nothing"`  |
| `GET`    | `/threads/{thread_id}`                       |                                               |
| `POST`   | `/threads/search`                            |                                               |
| `POST`   | `/threads/count`                             | How many match the filters (no pagination)    |
| `POST`   | `/threads/prune`                             | Bulk `delete`, or `keep_latest` history trim  |
| `GET`    | `/threads/{thread_id}/state`                 | Current state snapshot (`useStream` hydrates) |
| `POST`   | `/threads/{thread_id}/state`                 | Time travel: fork state at a checkpoint       |
| `GET`    | `/threads/{thread_id}/state/{checkpoint_id}` | Time travel: state at a checkpoint            |
| `POST`   | `/threads/{thread_id}/state/checkpoint`      | Same read, checkpoint given as an object      |
| `POST`   | `/threads/{thread_id}/history`               | Checkpoint history, newest-first (paged)      |
| `GET`    | `/threads/{thread_id}/history`               | Same, with `?limit` (the SDK sends `POST`)    |
| `PATCH`  | `/threads/{thread_id}`                       |                                               |
| `POST`   | `/threads/{thread_id}/copy`                  | Duplicates the thread + its history           |
| `DELETE` | `/threads/{thread_id}`                       |                                               |

**`if_exists` on thread creation.** `POST /threads` with a `thread_id` you choose defaults to
`if_exists: "raise"` — a 409 when that id is taken. `"do_nothing"` returns the **existing** thread
untouched, which makes `client.threads.create({ threadId: stableKey, ifExists: "do_nothing" })` a
get-or-create: the idiom for addressing a conversation by an external identity (a phone number, an email
thread, a ticket id) without tracking skein's own ids.

Uniqueness is enforced in the storage driver, not by a read-then-write in the service, so two instances
racing the same id cannot both win. Before this existed the two drivers disagreed: the memory driver
silently **overwrote** the thread — resetting its `created_at`, `metadata`, `status`, `values` and
`interrupts`, so an interrupted thread read as idle — while Postgres surfaced a raw unique violation as a 500.

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
- `GET /threads/{id}/state/{checkpoint_id}` reads the state snapshot at a specific checkpoint, and
  `POST /threads/{id}/state/checkpoint` reads the same thing with the pointer in the body. Both exist
  because the SDK picks between them by argument _type_: `threads.getState(id, "ckpt-1")` takes the
  `GET`, while `threads.getState(id, { checkpoint_id, checkpoint_ns })` takes the `POST`. Only
  `checkpoint_id` is read from the pointer either way. A pointer with no id reads the tip rather than
  404ing, and `subgraphs` is accepted and ignored on both.
- Run creation accepts a top-level **`checkpoint_id`** to start a run from a chosen checkpoint instead
  of the thread tip. This is **server-validated and server-injected** — it is _not_ read from the
  client's `config.configurable` (which strips it), so a client can never redirect a run to an arbitrary
  checkpoint. It rides the LangGraph checkpointer, so no extra storage is involved; thread copy is the
  coarser, whole-history cousin.

### Runs — stateless / ephemeral

Each of these creates its own thread. `on_completion` decides what happens to it (below).

| Method | Path           | Notes                                            |
| ------ | -------------- | ------------------------------------------------ |
| `POST` | `/runs/wait`   | Run to completion, answer with the final values  |
| `POST` | `/runs/stream` | Run and stream frames as SSE                     |
| `POST` | `/runs`        | Queue a background run, answer with the `Run`    |
| `POST` | `/runs/batch`  | An **array** of run-creates; max 100 per request |
| `POST` | `/runs/cancel` | `cancelMany` — see below                         |

### Runs — background (thread-scoped)

| Method   | Path                                               | Notes                             |
| -------- | -------------------------------------------------- | --------------------------------- |
| `POST`   | `/threads/{thread_id}/runs`                        | Start a background run            |
| `GET`    | `/threads/{thread_id}/runs`                        | List a thread's runs (paginated)  |
| `GET`    | `/threads/{thread_id}/runs/{run_id}`               | Fetch one run                     |
| `GET`    | `/threads/{thread_id}/runs/{run_id}/stream` (join) | Join a run's stream               |
| `GET`    | `/threads/{thread_id}/runs/{run_id}/join`          | Block until it settles, then JSON |
| `POST`   | `/threads/{thread_id}/runs/{run_id}/cancel`        | Cancel a run (`?action`, `?wait`) |
| `DELETE` | `/threads/{thread_id}/runs/{run_id}`               | Delete a run                      |
| `GET`    | `/runs/{run_id}/stream` (join)                     | Join by run id (thread-agnostic)  |

**Joining a run: two shapes.** `.../runs/{run_id}/stream` tails a run as SSE (`client.runs.joinStream()`,
resumable with `Last-Event-ID`). `.../runs/{run_id}/join` is the blocking form (`client.runs.join()`): it
waits for the run to settle and answers the thread's final `values` as plain JSON, or
`{ "__error__": ... }` for a failed one — the same envelope `POST /runs/wait` uses. Joining a run that has
_already_ settled returns immediately, including long after its frames have aged out of the event bus,
because the wait is decided by the run row rather than by the bus. `?cancel_on_disconnect` is accepted and
ignored: a JSON response has no disconnect signal to hang the behaviour on (neither does LangGraph's).

**Cancelling in bulk.** `POST /runs/cancel` takes `{ thread_id?, run_ids?, status? }`, narrowest
selector first: explicit `run_ids`, else one thread's inflight runs, else **every** inflight run on the
server. `status` is `pending` / `running` / `all` (the default). An unknown — or non-owned — run id is
skipped rather than failing the sweep, so the response reports what actually happened:
`{ cancelled_count, cancelled_run_ids, truncated }`. `truncated: true` means the whole-server sweep filled
the store's page bound and should be repeated; the SDK types this call as returning `void` and ignores the
body, so it is skein's to shape.

`truncated` is deliberately a boolean about the caller's own page rather than a count of what is left.
The per-thread concurrency guard the sweep reads through is **not** ownership-scoped — it has to see every
inflight run on a thread whoever started it — so a total would tell an authenticated caller how much work
every other principal has in flight.

**`?action` and `?wait` on a cancel.** Both are sent by every `client.runs.cancel(...)` and were
previously ignored. `action=interrupt` (the default) settles the run `cancelled` and keeps whatever it
wrote; `action=rollback` additionally discards its checkpoint writes and deletes the run row, so the turn
reads as never having happened. `wait=1` returns only once the run has actually stopped executing rather
than as soon as it is marked.

**`on_completion` on a stateless run.** `"delete"` removes the server-created thread once the run
settles; `"keep"` leaves it. **skein defaults to `keep`, LangGraph to `delete`** — a deliberate
divergence, so a stateless run stays inspectable and so adding the field did not silently change what
`/runs/wait` and `/runs/stream` already did. Pass `"delete"` for LangGraph's behaviour. An `interrupted`
run keeps its thread either way: it has yielded to a human, and its checkpoint is the whole value of the
turn.

**`Content-Location` on run creation.** Every run-create response (and `POST /threads/{id}/stream`)
carries `Content-Location: /threads/{thread_id}/runs/{run_id}`. The `@langchain/langgraph-sdk` client
parses it to fire `onRunCreated`, which is what `useStream` stores to rejoin a stream after a remount —
so without it that callback never fires and `reconnectOnMount` cannot work. It is also the only way a
caller learns the thread id of a stateless `/runs/wait`, whose body is the graph's state.

### Crons (LangGraph Platform extension)

| Method   | Path                              | Notes                                            |
| -------- | --------------------------------- | ------------------------------------------------ |
| `POST`   | `/runs/crons`                     | Stateless cron — a fresh thread per fire         |
| `POST`   | `/threads/{thread_id}/runs/crons` | Thread cron — reuses the named thread            |
| `POST`   | `/runs/crons/search`              | Filter + sort + page; `x-pagination-total`       |
| `POST`   | `/runs/crons/count`               | Returns a **bare integer**                       |
| `GET`    | `/runs/crons/{cron_id}`           |                                                  |
| `PATCH`  | `/runs/crons/{cron_id}`           | Tri-state `end_time`/`timezone`; metadata merges |
| `DELETE` | `/runs/crons/{cron_id}`           | **200 with a JSON body**, not 204                |

These are **not** in the open Agent Protocol spec — its `openapi.json` has no cron paths, and the OSS
`@langchain/langgraph-api` throws `500 Not implemented` on all of them. skein serves them against the
LangSmith Deployment OpenAPI spec plus the SDK's types. Two response shapes are deliberately unusual
because the official client requires them: `count` answers a bare integer, and `DELETE` answers 200
with a body (the SDK skips `response.json()` only for 202 and 204). Full semantics — schedule format,
catch-up, driver support, the scheduler — are in [crons.md](./crons.md).

### Meta

| Method | Path    | Notes                                                                |
| ------ | ------- | -------------------------------------------------------------------- |
| `GET`  | `/info` | Version + `flags` capability handshake (Studio reads it)             |
| `GET`  | `/ok`   | Liveness probe — served by each adapter, **outside** the route table |

`/ok` sits outside the protocol table on purpose. LangGraph groups it with `/info` under one
`disable_meta` flag; in skein it is the container health check (see the generated Dockerfile), so no
config flag may be able to make a healthy instance read as dead.

**`/info` is served unauthenticated**, even with an `auth` block configured — matching
`@langchain/langgraph-api`, whose auth middleware skips it explicitly. It is a handshake: Studio and
monitoring clients probe it before they have credentials, so requiring auth would break connecting to a
server `langgraph dev` would have answered. It exposes only versions and which resources are served.

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
asked for. `status` on `runs.list` **is** honoured, filtered in the driver so it pages the filtered set;
`select` on `runs.list` and `suffix`/`max_depth` on `listNamespaces` are still accepted and **ignored**.

### Thread streaming (SSE)

| Method | Path                                 | MVP |
| ------ | ------------------------------------ | --- |
| `POST` | `/threads/{thread_id}/stream`        | ✅  |
| `GET`  | `/threads/{thread_id}/stream`        | ✅  |
| `GET`  | `/threads/{thread_id}/stream/events` | ✅  |
| `POST` | `/threads/{thread_id}/commands`      | ✅  |

`GET /stream/events` is a synonym for `GET /stream`: `client.threads.joinStream()` asks for the
latter, the SDK's v2 agent-server transport reads from the former.

The v2 transport as a whole is **not** supported — its `POST /stream/events` is a subscription
(`{ channels, ... }`, carrying no `assistant_id`) rather than a run-create, and `/commands` expects a
protocol command envelope skein does not implement. Use the run endpoints, which is what `useStream`
does by default.

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

Auth follows LangGraph's
[custom-auth model](https://docs.langchain.com/langsmith/custom-auth) and is **transport-neutral**: it
lives in `@skein-js/agent-protocol`, wrapping the handler table every adapter mounts, so Express,
Fastify, NestJS, and Next.js inherit it identically. It's active only when an `Auth` engine is
configured — a `langgraph.json` `auth` block (see
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
   `crons` are ownership-scoped the same way, and **fall back to the `threads` handler when no
   `@auth.on.crons` callback is registered** — callbacks match by exact event key, so a deployment
   that scoped only threads would otherwise serve the cron resource unscoped. Attaching a schedule to
   a thread is additionally authorized as `threads:create_run`, so a cron cannot be pointed at a
   thread the caller cannot read. `assistants` and `store` are **gate-only** — their handlers can deny
   (`403`), but no ownership filter is applied yet (graph assistants have no owner and must stay
   runnable; store items carry no metadata to filter on).

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

| Endpoint(s)                                                                                                                                                                   | resource\:action                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `GET /assistants/{id}`, `/assistants/{id}/schemas`                                                                                                                            | `assistants:read`                               |
| `POST /assistants/search`                                                                                                                                                     | `assistants:search`                             |
| `POST /threads`                                                                                                                                                               | `threads:create`                                |
| `GET /threads/{id}`, `/state`, `/state/{checkpoint_id}`; `POST /state/checkpoint`, `/history`; `GET /history`, `.../runs`, `.../runs/{run_id}`, run join (stream or blocking) | `threads:read`                                  |
| `POST /threads/search`, `POST /threads/count`                                                                                                                                 | `threads:search`                                |
| `PATCH /threads/{id}`; `POST /threads/{id}/state` (state fork); run cancel; `POST /runs/cancel`                                                                               | `threads:update`                                |
| `DELETE /threads/{id}`; run delete; `POST /threads/prune`                                                                                                                     | `threads:delete`                                |
| run create (wait/stream/background/stateless/batch), thread stream / commands                                                                                                 | `threads:create_run`                            |
| `GET /info`                                                                                                                                                                   | _(unauthenticated — see the Meta section)_      |
| `PUT/GET/DELETE /store/items`, `/store/items/search`, `/store/namespaces`                                                                                                     | `store:{put,get,delete,search,list_namespaces}` |

**Reuse & limits.** The `Auth` contract and the `$eq`/`$contains` filter semantics come from
`@langchain/*`; skein adds only the instance-scoped dispatch (see [reuse.md](./reuse.md)). Ownership
scoping is pushed into the driver query (above), with the in-process check kept as the enforcement point.
Per-owner scoping of `assistants`/`store` is still on the [roadmap](./roadmap.md).

`POST /runs/cancel` sweeps broadly but authorizes narrowly: every run it touches goes back through the
ownership-filtered `get`, so a non-owned run reads as absent and is skipped. The per-thread concurrency
guard (`hasActiveRun` / `listActiveRuns`) is deliberately _not_ ownership-filtered — it must see every
inflight run on a thread whoever started it, or two runs could execute at once and interleave their
checkpoint writes. Nothing leaks: the thread itself is ownership-gated, so the guard is unreachable for a
thread the caller does not own.

## Conformance strategy

The official [`@langchain/langgraph-sdk`](./react-sdk.md) client is our **conformance
oracle**: if `client.threads.create()`, `client.runs.stream()`, and `client.runs.wait()`
are happy against a skein-js server, the wire format is correct. See
[roadmap.md](./roadmap.md#verification) for the full verification plan.

## References

- Agent Protocol repo + OpenAPI — <https://github.com/langchain-ai/agent-protocol>
- aegra's Agent Protocol implementation (Python prior art) — <https://github.com/aegra/aegra>
