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
[`packages/agent-protocol/src/http/routes.ts`](https://github.com/skein-js/skein-js/blob/main/packages/agent-protocol/src/http/routes.ts) is the
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
| `POST`   | `/threads`                                   | Create; `if_exists`, `supersteps` seed state  |
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
racing the same id cannot both win.

**Seeding a thread with `supersteps`.** `POST /threads` accepts a `supersteps` array — updates written
straight into the thread's checkpoint history, so you can **import** an existing conversation rather
than replaying it through the graph. Each superstep is one tick and becomes one checkpoint; each update
carries `values` (or a `command`) and a required `as_node` saying which node to attribute it to.

Writing state needs a graph, and a thread this new has no run to infer one from — so pass `graphId`,
which the SDK folds into `metadata.graph_id`. Without it this is a 400. That graph id is also what lets
the seeded state be **read back**: `GET /threads/{id}/state` and the history routes fall back to
`metadata.graph_id` when a thread has never run.

Bounded at 100 supersteps of 100 updates: each update is a graph-state write to the checkpointer.

Note supersteps are applied to whatever the create returned — including a thread that
`if_exists: "do_nothing"` merely _found_, in which case they append to it. That matches
`@langchain/langgraph-api`, which runs its bulk write on the result of the create either way.

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
becomes the checkpointer's filter. Checkpoint IDs, namespaces and checkpoint maps reach the checkpointer; the thread scope remains
server-owned, so a `thread_id` in `before.configurable` is dropped.

A `?limit=` query param is still accepted for hand-rolled callers, but it is _clamped_ to 1000 rather
than rejected (a query string has no schema to 400 from). The body wins if both are present.

`useStream` sends `limit: 10`, so 10 checkpoints come back rather than every one, matching LangGraph
Platform. The rendered transcript is unaffected (the newest checkpoint's
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
  `GET`, while `threads.getState(id, { checkpoint_id, checkpoint_ns })` takes the `POST`. The body pointer preserves `checkpoint_id`, `checkpoint_ns` and `checkpoint_map`. A namespace-only
  pointer reads that namespace’s current state. `subgraphs: true` includes recursive task state;
  the GET routes accept `?subgraphs=true`.
- Run creation accepts a top-level **`checkpoint_id`** to start a run from a chosen checkpoint instead
  of the thread tip. A full `checkpoint` pointer or validated `config.configurable` checkpoint coordinates also work.
  An explicit top-level ID wins. The server always supplies the owning thread ID. Coordinates
  survive queued execution, so the worker branches from the same checkpoint the caller selected.

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

**Run-completion deliveries.** A run created with a `webhook` records its callback in an outbox, so
the attempts are inspectable and a failed one can be re-sent:

| Method | Path                                                                 | Notes                                  |
| ------ | -------------------------------------------------------------------- | -------------------------------------- |
| `GET`  | `/threads/{thread_id}/runs/{run_id}/deliveries`                      | `?status=` · `?limit=` · `?offset=`    |
| `POST` | `/threads/{thread_id}/runs/{run_id}/deliveries/{delivery_id}/replay` | Makes a delivery due again immediately |

The list strips the stored `payload` — up to 256 KiB of the run's final state per row — and reports a
boolean `replayable` in its place; read the state from the run. Replay `409`s on a delivery that
already succeeded (its payload was cleared on success, so there is nothing left to send) and `404`s on
a delivery id that does not belong to the run in the path.

Both sit in the **`runs` route group** deliberately: a run is already an ownership-scoped resource, so
`http.disable_runs` and an existing `@auth.on.threads` handler cover them with no new switch and no new
`RouteGroup` — which, once shipped, could never be withdrawn. Delivery semantics, signing and
retention are in [webhooks.md](./webhooks.md).

**Configured-channel inventory.** When a deployment configures `skein.channels`, it also mounts
`GET /channels` for operator tooling. The response is intentionally small and sanitized:

```json
{
  "channels": [
    {
      "route_name": "support-whatsapp",
      "assistant": "support",
      "allowed_assistants": ["refunds"],
      "channel_name": "twilio",
      "delivery_supported": true
    }
  ]
}
```

The inbound path is derived as `/channels/{route_name}`. The endpoint never returns module paths,
`public_url`, raw configuration, credentials or reply destinations. It is absent when no channel is
configured and, under custom auth, requires `assistants:read`. This is a skein operator extension,
not part of the Agent Protocol or the upstream SDK resource clients; the console reuses the SDK's base
transport for it.

**Joining a run: two shapes.** `.../runs/{run_id}/stream` tails a run as SSE (`client.runs.joinStream()`,
resumable with `Last-Event-ID`). `.../runs/{run_id}/join` is the blocking form (`client.runs.join()`): it
waits for the run to settle and answers the thread's final `values` as plain JSON, or
`{ "__error__": ... }` for a failed one — the same envelope `POST /runs/wait` uses. Joining a run that has
_already_ settled returns immediately, including long after its frames have aged out of the event bus,
because the wait is decided by the run row rather than by the bus. `?cancel_on_disconnect` is honoured on
the **streaming** form and accepted-but-ignored on the blocking one, matching
`@langchain/langgraph-api` — see `on_disconnect` under the run endpoints below.

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

**`?action` and `?wait` on a cancel.** Both are sent by every `client.runs.cancel(...)`.
`action=interrupt` (the default) settles the run `cancelled` and keeps whatever it
wrote; `action=rollback` additionally discards its checkpoint writes and deletes the run row, so the turn
reads as never having happened. `wait=1` returns only once the run has actually stopped executing rather
than as soon as it is marked.

**`on_completion` on a stateless run.** `"delete"` removes the server-created thread once the run
settles; `"keep"` leaves it. **skein defaults to `keep`, LangGraph to `delete`** — a deliberate
divergence, so a stateless run stays inspectable and so adding the field did not silently change what
`/runs/wait` and `/runs/stream` already did. Pass `"delete"` for LangGraph's behaviour. An `interrupted`
run keeps its thread either way: it has yielded to a human, and its checkpoint is the whole value of the
turn.

**`if_not_exists` on run creation.** Naming a thread that does not exist is a **404** by default
(`if_not_exists: "reject"`, matching LangGraph). Pass `"create"` to have the run bring the thread into
existence instead — the other half of addressing a conversation by an external key, so an inbound event
can start a run without a round trip to create the thread first.

All three thread-scoped run routes agree, and the default is the safe one — a mistyped thread id fails loudly rather than running against a fresh empty thread with none
of the history the caller expected. Pass `if_not_exists: "create"` to restore the old behaviour.

**`if_thread_status` on run creation.** A skein extension, and the counterpart to `multitask_strategy`:
that one arbitrates `pending`/`running`, this one guards every other thread status. It matters most for
`interrupted`, which is a **terminal** run status — a thread waiting on a human holds no inflight run,
so no multitask strategy protects it and a plain start discards the pending interrupt. Send
`if_thread_status: ["idle", "error"]` and an interrupted thread answers **409 `thread_status_mismatch`**
with the observed status in `details`. Settled inside the driver's atomic create, so it holds across
replicas. A storage driver that does not implement the precondition answers
`501 if_thread_status_unsupported` rather than degrading to a non-atomic check.

A thread created this way still belongs to the **caller**, not to the run: `on_completion: "delete"`
never removes it, because the caller named it. Only a thread the server minted (no `thread_id` at all)
is the run's to delete.

The field is inert on `POST /runs` and `/runs/batch`, which strip `thread_id` outright — the server owns
a stateless run's thread, so nothing can be missing.

**`after_seconds` on run creation.** Holds the run for that many seconds before it starts — the SDK's
"schedule a future run". Capped at **86400** (a day); anything longer is a [cron](./crons.md).

A **background** run (`POST /runs`, `/runs/batch`, `POST /threads/{id}/runs`) is held by the queue
itself. Redis keeps delayed jobs in BullMQ's delayed set; SQLite persists unclaimed jobs with their
original due times. Both retain waiting jobs across a process restart. On the in-memory queue the
delay is a timer, lost on restart along with the other queued jobs. Abandoned active attempts follow
each [queue driver's crash behavior](./runs-and-redis.md#queue-drivers).

An **inline** run (`/runs/wait`, `/runs/stream`) has no queue to hold it, so the server waits with your
connection open. A stream still responds immediately — the run row, its `Content-Location`, and the
SSE heartbeats all come first, and only execution is deferred — but `/runs/wait` sends nothing until
the run finishes, so a long `after_seconds` there will hit a proxy's idle timeout. Prefer a background
run for anything more than a few seconds.

Two consequences worth knowing. The run row exists for the whole delay with status `pending`, so it
counts as **inflight**: a second run on that thread under the default `multitask_strategy: "reject"` is
refused until the delayed one starts. That is the honest reading — work _is_ scheduled on the thread —
but it surprises people. And a delayed run is cancellable like any other; `POST .../cancel` settles it
before it ever runs.

**`on_disconnect` on run creation.** `"cancel"` settles the run when the caller's connection drops;
`"continue"` lets it finish. Only the inline routes (`/runs/wait`, `/runs/stream`) hold a connection to
drop, which is why the SDK does not send it on a background create.

**skein defaults to `"continue"`.** A proxy idle timeout or a load-balancer reset is indistinguishable
from a real hang-up at this layer, so defaulting to cancel would let routine infrastructure kill a
healthy run. Note `useStream` sends `"cancel"` on every submit unless the stream is resumable — so with
a browser client, closing the tab stops the run. That is LangGraph's behaviour.

The related query flag `?cancel_on_disconnect` is honoured on `GET .../runs/{run_id}/stream`
(`client.runs.joinStream()`), matching `@langchain/langgraph-api`. It stays **accepted and ignored** on
the blocking JSON `.../join`, because the reference server does not read it there either — a blocking
join should not behave differently against the two servers the same client talks to.

Adapters supply the disconnect signal from their own transport (`res` close, or the Web `Request`'s
`signal`). An adapter that cannot observe disconnects simply omits it, and `"cancel"` degrades to
`"continue"` rather than failing.

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

| Method   | Path                  | Notes                                          |
| -------- | --------------------- | ---------------------------------------------- |
| `PUT`    | `/store/items`        | Upsert an item (optional `ttl`)                |
| `GET`    | `/store/items`        | Fetch by `?namespace=a.b&key=…`                |
| `DELETE` | `/store/items`        | `{ namespace, key }` in the body, or the query |
| `POST`   | `/store/items/search` | pgvector semantic search, `filter` → `{items}` |
| `POST`   | `/store/namespaces`   | Prefix/suffix/depth → `{namespaces}`           |

**`DELETE` takes a body.** The SDK's two single-item methods use different transports on the same path:
`store.getItem` sends `?namespace=a.b&key=…`, while `store.deleteItem` sends a JSON body with
`namespace` already an array. skein accepts **either** on both, body first. Reading only the query made
every SDK `deleteItem` a silent no-op — empty namespace, empty key, nothing deleted, `204`.

**Response shapes.** Search returns `{ "items": [...] }` and namespaces `{ "namespaces": [...] }` —
the envelopes the SDK's `store.searchItems` / `store.listNamespaces` read. Store items carry
`created_at`/`updated_at`, like every other resource here.

**`filter` on search** narrows by the **top-level** keys of an item's `value` — `"a.b"` is the literal
key `"a.b"`, not a path into a nested object. Keys are ANDed, and so are multiple operators on one key.
The operator set is LangGraph's: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`; a bare
scalar means equality. Filtering happens before paging, so a page is a page of matches. An unknown
operator or a non-scalar filter value is a **400**, not a silent narrowing — see
[storage.md](./storage.md) for the full semantics, including the one place skein's ordering operators
deliberately differ from LangGraph's.

**Namespace matching** takes `prefix` and `suffix` (ANDed) and `max_depth`. `"*"` matches exactly one
segment, positionally — so `["users","*"]` selects the `users` subtree, matching `["users","1"]` and
`["users","1","memories"]` alike. Before 0.14 a wildcard was dropped and read as _no prefix_, so that
same request returned **every namespace in the store**. `max_depth` truncates each match and
de-duplicates, before paging.

**Pagination on these two.** `GET /threads/{thread_id}/runs` takes `?limit`/`?offset` and
`POST /store/namespaces` takes `limit`/`offset` in the body; both default to a **100**-row page, the
same default the SDK sends for `store.listNamespaces`. A query `limit` above 1000 is clamped rather than
rejected, matching every other query-string limit here. Truncation is not signalled on the response
(only assistant search carries `x-pagination-total`), so page until you receive fewer rows than you
asked for. `status` on `runs.list` **is** honoured, filtered in the driver so it pages the filtered set;
`select` on `runs.list` remains accepted without projection. Store reads and searches honor
`refresh_ttl` as a per-request override of `store.ttl.refresh_on_read`.

### Thread streaming (SSE)

| Method | Path                                 | MVP |
| ------ | ------------------------------------ | --- |
| `POST` | `/threads/{thread_id}/stream`        | ✅  |
| `GET`  | `/threads/{thread_id}/stream`        | ✅  |
| `GET`  | `/threads/{thread_id}/stream/events` | ✅  |
| `POST` | `/threads/{thread_id}/stream/events` | ✅  |
| `POST` | `/threads/{thread_id}/commands`      | ✅  |

`POST /threads/{thread_id}/stream/events` subscribes to the thread event protocol. Its body
contains `channels`, optional namespace prefixes, `depth`, and an optional numeric `since` cursor.
It never creates a thread or run. Without a cursor it sends a current state baseline followed by live
events; with a cursor it replays retained events after that sequence and then follows live events.
An expired or future cursor reports `thread_cursor_expired`; restore state and subscribe afresh.

`POST /commands` recognizes `{ id, method, params }` envelopes and answers correlated JSON
success/error responses. Implemented methods are `run.start`, `input.respond`, `agent.getTree`,
`state.get`, `state.listCheckpoints`, and `state.fork`. Run commands enqueue through the existing
worker; a subscription or reconnect never invokes the graph. Existing resume/goto/update bodies
continue to return legacy SSE. State reads require read permission, run starts require `create_run`,
and forks also require state-write and destination-creation permission.
`state.fork` verifies the source checkpoint in the configured saver before copying; custom-agent
snapshots do not need a `createdAt` timestamp to identify a valid stored checkpoint.

`GET /stream/events` remains an alias for `GET /stream`. Without parameters these join one run
and finish with it, preserving Skein's established default. Explicit `stream_mode` (repeated or
comma-separated; what the SDK's `threads.joinStream` sends) opts into a thread stream that stays
open across turns. `run_modes` includes every run frame and completion metadata. `lifecycle`
emits only `metadata` events: `{ run_id, attempt: 1 }` when execution starts and
`{ status: "run_done", run_id }` when it ends. `state_update` emits
`{ thread_id, state }`, where `state` is the full checkpoint snapshot captured when the run ends
or state is updated directly. Replay preserves each historical snapshot. Individual frame modes
and the Skein-specific `thread_state` thread-row events remain supported. SSE event IDs are thread-wide cursors, rather than
per-run frame IDs. Without `Last-Event-ID` it starts with live events; with one it replays after it.

Thread subscriptions require `ProtocolDeps.threadBus`; the built-in runtime assemblers provide it.
Memory replay is process-local. Redis replay is shared between API replicas and workers. Neither
publisher stores subscriber credentials or subscription filters: authorization and filtering happen
for each reader during replay and live delivery. See the [tested compatibility matrix](./langgraph-compatibility.md).

> The protocol also describes a WebSocket upgrade for bidirectional streaming. That is
> **post-MVP** — SSE covers the full client UX (see [streaming.md](./streaming.md)).

## Request/response conventions

- JSON for all non-streaming payloads.
- Request bodies carry `input`, optional `metadata`, optional `config`.
- Responses carry status (`pending` / `success` / `error`), timestamps, and resource IDs.
- A failed run also carries `error` — a skein extension over the SDK's `Run`, which records only
  _that_ a run failed. See [errors-and-logging.md](./errors-and-logging.md).
- Schemas use JSON Schema for interoperability.

## Idempotent run creation (`Idempotency-Key`)

A skein extension — LangGraph Platform has no equivalent. Send an `Idempotency-Key` header on a run
create and a retry of that request returns the **original response** instead of starting a second
run.

This exists because every webhook provider retries: Twilio on timeout or 5xx, Stripe, GitHub, Slack,
SendGrid. Without it, a retried delivery means a second reply to the end user or two agents acting on
one event — and the failure is silent. The only other defence is a dedup table re-implemented inside
every caller's application.

**Supported on** `POST /threads/{thread_id}/runs`, `POST /threads/{thread_id}/runs/wait`,
`POST /runs`, `POST /runs/wait`, and `POST /runs/batch`. Omitting the header is exactly today's
behaviour, so this is purely additive.

**Not supported on the streaming creates** (`POST /runs/stream`,
`POST /threads/{thread_id}/runs/stream`, `POST /threads/{thread_id}/stream`,
`POST /threads/{thread_id}/commands`), which answer with a live SSE stream: there is no body to
record, and consuming the stream to make one would break it for the caller who asked. Sending the
header there is a **422** rather than being ignored — a silently-dropped key would leave you
believing your retries are deduplicated while every one starts another run.

| Case                                             | Response                                                       |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Key unseen                                       | Executes normally; the response is recorded                    |
| Key seen, same request, original done            | The recorded response verbatim, plus `Idempotent-Replay: true` |
| Key seen, same request, original still in flight | `409` `idempotency_key_in_flight` — retry shortly              |
| Key seen, **different** request body             | `422` `idempotency_key_reused` — a caller bug; do not retry    |
| Key over 255 chars, or not printable ASCII       | `422` `invalid_idempotency_key`                                |

The `code` carries the meaning on the 422s: these routes already answer 422 for a _transient_ reason
(`thread_busy`, under the `reject` multitask strategy), and the two demand opposite client behaviour.
Keys follow Stripe's 255-character limit.

`Content-Location` is replayed with the rest of the response, so the SDK's `onRunCreated` still fires
and `useStream`'s `reconnectOnMount` still works on a retry.

A few properties worth knowing:

- **The claim is atomic across instances.** The record is inserted first and the store's uniqueness
  constraint arbitrates, so two provider retries landing on two pods milliseconds apart still produce
  exactly one run. Held to that by the shared `SkeinStore` conformance suite, on every driver.
- **Keys are scoped per principal** when auth is configured, so one caller cannot replay another's
  response by guessing their key.
- **A replay is re-authorized.** It answers from the record without reaching the handler table, so
  the route's `@auth.on.*` check runs again first — and when it returns ownership filters, the
  recorded thread is re-read through the scoped store. Revoking a caller's access stops their replays
  at once rather than at the end of the retention window.
- **Failures are never recorded.** A create that throws or answers non-2xx releases its key, so the
  next retry really runs — pinning a transient 503 for the retention would make a momentary outage
  permanent for that key.
- **At-least-once, not exactly-once.** The guarantee is that a retry of the _same_ request does not
  create a second run. Choose keys that are stable across retries (the upstream provider's message id
  is usually right).
- **Deleting a thread or a run erases its recorded responses.** A recorded response has to outlive
  its run for a replay to mean anything, and for `POST /runs/wait` that response _is_ the graph's
  final state — so `DELETE /threads/{thread_id}` takes the matching records with it, as do
  `DELETE /threads/{thread_id}/runs/{run_id}`, an assistant delete, and thread-TTL expiry. Erasure
  means erasure; a retry afterwards executes again rather than replaying, and on a deleted thread
  that is a 404.

  The one deletion that does **not** erase is a stateless run tidying up its own server-created thread
  (`on_completion: "delete"`). That thread is an implementation detail of `POST /runs`, disposed of on
  every such run — scrubbing there would destroy the record moments after writing it and break
  retries for exactly the case the header exists for. Those records expire on `retention_hours` like
  any other. Lower it if you want that window shorter.

  `POST /runs/batch` records carry no thread: their runs may span several, and the body is a list of
  run rows rather than conversation content.

Retention is tunable under `skein.idempotency` in `langgraph.json` — see
[langgraph-cli-compat.md](./langgraph-cli-compat.md#idempotency-skeinidempotency).

## Authentication + authorization

Auth follows LangGraph's [custom-auth model](https://docs.langchain.com/langsmith/custom-auth) and is
**transport-neutral** — it wraps the handler table, so every adapter inherits it identically. Active
only when an `Auth` engine is configured (a `langgraph.json` `auth` block or an injected `auth` dep);
otherwise the server is unauthenticated.

Per request:

1. **Authenticate** — run the user's `authenticate` handler → an `AuthContext`, or `401`. The CLI
   requires credentials for Studio, regardless of its self-declared `x-auth-scheme: langsmith` header.
   In loopback `skein dev`, `--dev-ui-access` or `auth.dev_ui_access: true` creates a temporary API
   key for both Studio and the console. A directly injected `AuthEngine` may choose its own Studio
   policy.
2. **Authorize** — run the matching `@auth.on.*` handler (priority `resource:action` → `resource` →
   `*:action` → `*`) → `403` on `false`, else an ownership **filter**.
3. **Dispatch** — with the authenticated `user`. Ownership scoping applies to the `threads` family
   (threads + their runs): a non-owned row reads as absent (`404`, never `403`), and the filter's values
   are stamped onto rows it creates. `crons` scope the same way and **fall back to the `threads`
   handler when no `@auth.on.crons` callback is registered**, since callbacks match by exact event key
   and a deployment that scoped only threads would otherwise serve crons unscoped. `assistants` is
   **gate-only** — a handler can deny, but no filter applies, because auto-registered graph assistants
   have no owner and must stay runnable. Store scoping works through the namespace instead:

### Scoping the store

A store item carries no metadata, so an ownership filter has nothing to match on. LangGraph's idiom is
to **rewrite** `value.namespace`, and skein honours it on all five store routes:

```ts
auth.on("store", ({ user, value }) => {
  value.namespace = [user.identity, ...(value.namespace ?? []).slice(1)];
});
```

In-place mutation counts (`value.namespace[0] = …`), and the body namespace wins over query params on
`GET`/`DELETE`. `value.key` is honoured the same way on `put`/`get`/`delete`. A rewrite that is not a
`string[]` is a **500** (`store_namespace_rewrite_invalid`), not a silent fall-through — a handler that
meant to scope and got the shape wrong is exactly the failure this prevents. Assigning `value.key` on
`search` or `list_namespaces` is likewise a 500 (`store_key_rewrite_invalid`): there is nowhere for it
to land. If you supply your own `AuthEngine`, its `authorize` must return the **same** `value` object
for a rewrite to be observable.

> **With no store handler registered, nothing narrows a store read.** The namespace is a request
> parameter, so any authenticated caller can send `{"namespace_prefix": ["memories"]}` — or omit the
> prefix entirely — and read **every** tenant's items. `POST /store/namespaces` likewise returns every
> tenant's namespace names.

Three traps if you validate rather than rewrite:

```ts
// A namespace label is one segment: it must contain neither `.` (the query separator) nor `*` (the
// positional wildcard). encodeURIComponent escapes neither, so do it explicitly.
const tenantLabel = (identity: string) =>
  encodeURIComponent(identity).replace(/\./g, "%2E").replace(/\*/g, "%2A");

auth.on("store", ({ user, value }) => {
  const namespace = value.namespace; // server-derived; absent means "every namespace" on search
  if (!namespace?.length || namespace[0] !== tenantLabel(user.identity)) {
    throw new HTTPException(403, { message: "Out of scope." });
  }
});
```

- **Require a namespace; don't just reject suspicious ones.** A deny handler can refuse a request but
  never filter the result. An absent prefix reads every tenant, and a `"*"` wildcard matches a strict
  **subset** of what the shorter literal prefix already returns — so blocking wildcards buys nothing.
- **Encode the identity.** `GET /store/items` takes a dot-joined query string, so `alice@corp.com`
  writes to `["alice@corp.com", …]` but reads back as `["alice@corp", "com", …]`. Emails and OIDC
  subjects hit this constantly.
- **A handler cannot cover `getStore()` inside a graph** — that is not an HTTP request and has no
  principal. Build the namespace from `config.configurable.langgraph_auth_user_id`, never from model
  output.

`value.namespace` is **server-derived** — set after merging the body, from the field the endpoint will
really use. Store bodies are `passthrough`, so otherwise a caller could send a decoy `namespace` that
satisfied the handler while the endpoint searched from an absent `namespace_prefix`.

### Where scoping runs

**In the database.** An ownership-filtered thread search becomes a metadata containment clause
(`metadata @> …` in Postgres, hitting `threads_metadata_idx`), so `limit`/`offset` page owned rows
directly rather than reading everything and filtering in JS.

The in-process `matchesFilters` check still runs and is what actually enforces ownership. The
translation errs **broad**, omitting any clause it cannot express exactly, because a too-strict clause
would silently hide rows a caller owns. A **custom** `AuthEngine` whose `matchesFilters` is stricter
than its own filters is the exception — pages then come back short; keep the two consistent.

**Principal in the run config.** Nodes read `config.configurable.langgraph_auth_user`,
`langgraph_auth_user_id` and `langgraph_auth_permissions`. Server-owned and reserved, so a client
cannot spoof them, and persisted on the run so a background run resumed elsewhere injects the same
principal. With no `auth` configured, no keys are added.

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

`POST /runs/cancel` sweeps broadly but authorizes narrowly — every run goes back through the
ownership-filtered `get`, so a non-owned run reads as absent and is skipped. The per-thread concurrency
guard is deliberately **not** ownership-filtered: it must see every in-flight run on a thread whoever
started it, or two could execute at once and interleave checkpoint writes. Nothing leaks, since the
thread itself is gated.

## References

- Agent Protocol repo + OpenAPI — <https://github.com/langchain-ai/agent-protocol>
- aegra's Agent Protocol implementation (Python prior art) — <https://github.com/aegra/aegra>

### Execution, search and retention options

Run creation accepts optional `timeout_ms`: integer milliseconds from **1** through **2,147,483,647**.
It is persisted with the run, including queued, native start/resume, and BullMQ command inputs.
The duration begins when execution starts, so queue delay does not consume it. The effective budget
is the minimum of this duration, the deployment's run limit, and any remaining native deadline.
Timeouts follow the same cancellation and terminal `timeout` settlement path as deployment limits.
`GET /info` optionally reports `flags.per_run_timeout: true` when supported. No new configuration
key or endpoint is needed; omission preserves existing behavior.

Thread responses optionally include `ttl`, `expires_at`, and `ttl_strategy`; store item/search
responses optionally include `ttl` and `expires_at`. Durations are minutes. Missing means unavailable;
`null` means known no expiry. Refresh-enabled store reads return the updated expiry. These are
optional projections, preserving compatibility with custom drivers.

Run requests preserve `durability: "sync" | "async" | "exit"` through the queue. It takes precedence
over deprecated `checkpoint_during`; explicit `true` maps to `async`, explicit `false` to `exit`, and
omission keeps LangGraph’s default. Legacy SSE also recognizes `tasks` and `checkpoints` modes.

Thread search supports `exclude_metadata` (one nonempty object or a nonempty list, excluding any
matching subset), `sort_by: "state_updated_at"`, `select`, and up to ten named `extract` paths.
Extraction accepts roots `values`, `metadata`, `config`, and `interrupts`, dot properties and array
indices such as `values.messages[-1].content`; absent values become `null`. Extracted aliases are
returned in an `extracted` object, alongside selected fields, and cannot overwrite thread identity.
Filters run before
pagination; projection and extraction run after authorization. Assistant and cron search support
`select`. HTTP assistant name matching is case-insensitive substring matching; direct repository
calls retain exact matching unless `nameMatch: "substring"` is requested.

Store writes accept `index: false | string[]` and `ttl: null` for an explicit no-expiry item.
`GET /store/items?refresh_ttl=false` and store search `refresh_ttl` control sliding expiry per read.
Custom stores that cannot honor requested indexing or TTL controls fail explicitly.

Thread TTL objects accept `strategy: "keep_latest"` with their TTL minutes. The sweeper retains the
thread and current checkpoint in every retained namespace, including referenced child checkpoints
and pending writes. State updates refresh that window; active runs are skipped. `delete` remains
the default strategy and explicit `ttl: null` pins a thread. See [storage](./storage.md).

### MCP and A2A

`/mcp` uses the official MCP SDK’s stateless Streamable HTTP transport. Tools list authorized
assistants and their input schemas. Calling a tool creates a run through the same authorized run
service; cancellation uses the existing run cancellation machinery.

`POST /a2a/{assistant_id}` uses the official A2A SDK’s JSON-RPC handlers and legacy codecs.
Discovery is `GET /.well-known/agent-card.json?assistant_id=...`; `DEFAULT_A2A_ASSISTANT_ID` supplies
an omitted assistant and `LANGGRAPH_API_URL` supplies the public origin. Supported method families
are `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `ListTasks`,
`GetExtendedAgentCard` and the four legacy send/stream/get/cancel names.

An A2A context maps to a thread. Each new task starts a queued run; a continuation keeps the first
run’s task ID. Final output is captured before terminal status on existing run rows, independently
of checkpoint pruning and event replay. Optional `RunRepo.recordResult/getResult` support is
required before A2A admits work; ordinary Agent Protocol runs remain usable with older drivers.
Resume checks the saved checkpoint under the existing execution lease and rejects stale tasks.
Cancellation status takes precedence over a computed output.

History defaults to the context. The advertised history-scope extension accepts `task` in
`configuration.historyScope` for sends, in `params.historyScope` for reads/listing, or through
`LangGraph-A2A-History-Scope`. Length is bounded to ten, after scope. Streaming omits response
history. Assistant `metadata.a2a.input_modes`/`output_modes` customize nonempty advertised MIME
lists. File parts preserve bytes or URLs, MIME and filenames through standard content blocks.

Skein advertises HTTP/SSE, history scope and streaming. It does not advertise A2UI, task push
notifications or subscription-to-task support. These unsupported methods fail explicitly. Dedicated
frontend browser and packed-package gates validate clients separately from these transport tests.
`http.disable_mcp` and `http.disable_a2a` remove their route groups.

### Discovery and storage diagnostics

`GET /openapi.json` and `/docs` describe the mounted route table and request schemas, including
configured route groups and deployment-supplied authentication descriptions. `/metrics` exposes
host-owned OpenTelemetry collection (501 when unavailable). Authorized
`GET /threads/{thread_id}/storage` returns concrete saver payload counts and bytes, or 501 for a
custom saver without an inspector. These routes use the common adapter/runtime paths; see
[diagnostics](./observability.md#http-diagnostics) for measurement boundaries.
