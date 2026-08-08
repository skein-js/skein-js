# Agent memory

**What this gives you:** the patterns for giving an agent memory on skein, and the traps that are not
obvious until they bite. There is no `@skein-js/memory` package to install — memory is something you build
in your graph out of pieces that already exist, and this page is the map of which pieces, and why.

That is a deliberate choice. Memory is _agent behaviour_, and skein's job is durable persistence, the
queue, the adapters and the CLI. Everything below is ~100 lines in your own graph, portable to LangGraph
Platform because it uses `getStore()` and nothing skein-specific. Where skein does contribute — durable
storage, semantic search, schedules — it is called out. Per-owner isolation is **not** on that list: it is a
policy your `@auth.on.store` handler decides, and [Multi-tenant memory](#multi-tenant-memory) is how.

## Contents

- [What you already have](#what-you-already-have)
- [Short-term memory is already solved](#short-term-memory-is-already-solved)
- [Long-term memory: profile and collection](#long-term-memory-profile-and-collection)
- [The dedup trap](#the-dedup-trap)
- [Recall](#recall)
- [Multi-tenant memory](#multi-tenant-memory)
- [Writing memories in the background](#writing-memories-in-the-background)

## What you already have

| Need                            | Use                                                              | From                                                                         |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Durable thread state            | the checkpointer — `PostgresSaver` in prod, `MemorySaver` in dev | skein wires it ([storage.md](./storage.md))                                  |
| Trimming a long conversation    | `trimMessages`, `filterMessages`, `RemoveMessage`                | `@langchain/core`                                                            |
| Summarizing a long conversation | `summarizationMiddleware`, `contextEditingMiddleware`            | the `langchain` v1 package                                                   |
| Cross-thread memory store       | `getStore()` — namespace/key items, vector search                | skein injects it into every run                                              |
| Semantic search over memories   | `store.index` (pgvector, HNSW optional)                          | skein ([storage.md](./storage.md#drivers))                                   |
| Per-owner isolation             | an `@auth.on.store` handler that roots the namespace             | you ([agent-protocol.md](./agent-protocol.md#authentication--authorization)) |
| Scheduled background extraction | a cron firing an extractor graph                                 | skein ([crons.md](./crons.md))                                               |
| Memory _shapes_, tools, dedup   | this page                                                        | you, in ~100 lines                                                           |

## Short-term memory is already solved

Worth stating plainly, because "durable short-term memory" sounds like a gap and is not one.

**Durability** is the checkpointer. `PostgresSaver` persists a thread's state and history, so a
conversation survives restarts and resumes from an interrupt; thread TTL collects the ones that go stale.
skein selects it for you — nothing to build.

**Context management** — keeping a long thread inside the model's window — is upstream too:

```ts
import { createAgent, summarizationMiddleware } from "langchain";

const agent = createAgent({
  llm,
  tools,
  middleware: [summarizationMiddleware({ model: llm, trigger: { tokens: 4000 }, keep: 20 })],
});
```

Do **not** write your own trimming loop. If you keep a running summary yourself, keep it in **graph
state** rather than the store: state is checkpointed, thread-scoped, and rolls back with the checkpoint,
none of which is true of a store item.

## Long-term memory: profile and collection

Cross-thread memory is `getStore()` — namespace/key JSON documents, the same store LangGraph Platform
auto-provides. Two shapes cover almost everything, and the choice is really "one document or many":

**Profile** — one continuously-updated document. Good for stable facts with one current value: timezone,
tone, home airport. Read it whole, merge a patch, write it back.

**Collection** — many documents accumulated over time. Good for open-ended facts: "prefers morning
meetings", "allergic to shellfish". Append, and retrieve by relevance rather than reading all of them.

```ts
const NAMESPACE = (userId: string) => [userId, "memories"] as const;

// Profile: read-modify-write one document.
async function mergeProfile(store: BaseStore, userId: string, patch: Record<string, unknown>) {
  const current = (await store.get([userId], "profile"))?.value ?? {};
  await store.put([userId], "profile", { ...current, ...patch });
}
```

**Pick one merge rule and write it down.** The rule matters less than having one; without it the profile
becomes unpredictable, which is the failure LangChain's own memory guide warns about. A rule that works:
_shallow, patch wins, arrays unioned, `null` deletes, nested objects replaced._ Replace rather than
deep-merge — deep merge makes deletion inexpressible.

Two things to know:

- **There is no compare-and-swap.** `BaseStore` has none, so read-modify-write is last-writer-wins. On
  skein, runs on one thread are serialized by the execution lock, so concurrent merges only arise across
  threads for the same user. Do not build an optimistic-retry counter — without CAS it does not close the
  race and implies a guarantee that is not there.
- **Keep collection fields top-level and scalar.** `search`'s `filter` reads the _top-level_ keys of an
  item's `value` and takes scalars, so `{ content, kind, createdAt }` filters and `{ meta: { kind } }`
  does not. `tags: string[]` is storable but not filterable (`$in` asks the opposite question). Full
  operator semantics in [storage.md](./storage.md#filtering-and-namespace-traversal).

## The dedup trap

**The most important paragraph on this page.** Without dedup, an agent that saves a memory each turn
accumulates the same fact dozens of times and recall degrades into noise. The obvious fix — semantic
search for a near-duplicate before writing — **inverts** on most substrates:

| Substrate                                              | `score` on a text search |
| ------------------------------------------------------ | ------------------------ |
| `@skein-js/storage-memory` (dev)                       | **`1` for every hit**    |
| `@skein-js/storage-postgres` **without** `store.index` | **`1` for every hit**    |
| `@skein-js/storage-postgres` **with** `store.index`    | real cosine similarity   |
| LangGraph `InMemoryStore` without an index             | no `score` field at all  |

So `score >= 0.9 means duplicate` classifies _everything_ as a duplicate on two of three substrates, and
your agent **silently stops recording memories**. It will not error. You will notice weeks later.

Two rules:

**1. Dedup on content, not similarity.** A content-addressed key makes exact dedup free, with no read at
all — saving the same sentence twice upserts one row instead of appending a second:

```ts
async function memoryKey(content: string): Promise<string> {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return `mem-${[...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
```

Use `globalThis.crypto.subtle`, not `node:crypto` — it is present on Node ≥20, Bun, Deno and workers, so
the same graph still runs on an edge runtime.

**2. Treat semantic dedup as opt-in, requiring `store.index`.** And check the scores are meaningful before
trusting them — at least one candidate scoring **strictly below 1** — falling back to exact dedup
otherwise. State the safe direction out loud: **dedup errs toward writing.** A duplicate is recoverable;
a dropped memory is not.

One more, on cost: on Postgres _without_ `store.index`, a `query` search is an unbounded full-table read
filtered in JS. Semantic dedup on every write there reads the whole `store_items` table each time.

## Recall

Retrieval is `store.search` with the namespace and filter already right:

```ts
const relevant = await store.search([userId, "memories"], { query: latestUserMessage, limit: 5 });
```

**When to recall is your graph's decision, and skein has no opinion.** Two patterns, both fine:

- **Auto-inject** — fetch relevant memories before each model call and fold them into the system message.
  Personalization does not depend on the model remembering to ask. This is what
  [`examples/chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app) does.
- **A recall tool** — the model calls `search_memory` when it decides it needs to. Fewer tokens per turn,
  but it only works when the model chooses well.

If you expose memory as a **tool**, bind the namespace server-side and give the model no namespace
parameter at all:

```ts
// The model may choose *which collection*, from an enum — never which namespace.
const userId = config.configurable?.langgraph_auth_user_id; // never model output
```

That is the pattern people get wrong: a namespace the model can name is a namespace the model can escape.

## Multi-tenant memory

Memory is per-user by definition, so this matters more here than anywhere else in skein.

`prefix`, `suffix` and `filter` are **request parameters, not access control**. An omitted prefix matches
every namespace. The control is an **`@auth.on.store` handler** that rewrites `value.namespace` to root the
caller — LangGraph's own idiom, and skein honours it. See
[agent-protocol.md](./agent-protocol.md#authentication--authorization).

It covers the HTTP surface. **`getStore()` inside a graph has no request and no principal**, so nothing
guards it for you. Build its namespace from `config.configurable.langgraph_auth_user_id` (server-injected and
unspoofable), never from model output, use the same encoding your handler uses — and encode it: an identity
containing `.` splits into two namespace segments on `GET /store/items`, and `PostgresStore` rejects `.`,
`%`, `_` and `\` in a label outright.

## Writing memories in the background

Extracting memories inline costs the user's turn a model call. Two ways to move it off the hot path, both
working today with no new skein surface:

**A cron.** Point a [schedule](./crons.md) at an extractor graph — an ordinary graph you write, with your
model and your prompt — and it runs on a cadence, durably, across restarts and instances:

```jsonc
{ "graphs": { "agent": "./src/agent.ts:graph", "extract-memories": "./src/extract.ts:graph" } }
```

**A debounced follow-up run.** Closer to real-time: when a turn finishes, create a _stateless background
run_ of the extractor with `after_seconds`, and cancel this thread's pending one first so extraction fires
once when the conversation pauses rather than once per turn. `after_seconds` is backed by the queue, so a
pending extraction is a **row in the store** and survives the process that scheduled it — which is the part
an in-process scheduler (Python `langmem`'s `ReflectionExecutor`, say) cannot give you without a server
behind it.

```ts
// Cancel the pending extractor for this thread, then schedule a fresh one.
const inflight = await client.runs.list(threadId);
for (const run of inflight.filter((r) => r.metadata?.extractor && r.status === "pending")) {
  await client.runs.cancel(threadId, run.run_id);
}
await client.runs.create(null, "extract-memories", {
  afterSeconds: 30,
  input: { thread_id: threadId },
  metadata: { extractor: true },
});
```

The one thing neither expresses: a graph node cannot know its own run _settled_, so "extract only from
successful runs, reliably even on error and cancellation paths" is not reachable from inside the graph. A
server-side settled-run trigger would cover it; it is
[deferred](./roadmap.md), because everything above works without it and the gap is narrow.

## See also

- [storage.md](./storage.md) — the store itself: drivers, `getStore()`, filters, TTL, scoping, BYO store
- [crons.md](./crons.md) — schedules, for the cron extraction pattern
- [`examples/chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app) — a working research assistant with memory and recall
- [LangChain's memory guide](https://docs.langchain.com/oss/javascript/concepts/memory) — the
  profile/collection framing this page builds on
