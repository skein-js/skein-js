# Agent memory

A travel assistant should remember “I prefer aisle seats” when the user starts a new conversation.
A support agent should remember facts from this ticket without mixing them into another customer's
history. Use thread state for the current conversation and the store for facts that need to outlive it.

Write and retrieve those facts in your graph with LangGraph's `getStore()`. Configure skein-js storage
for the required lifetime, and scope each user's namespaces through your authorization policy. Start
with the patterns below; [multi-tenant memory](#multi-tenant-memory) covers isolation.

## What you already have

| Need                            | Use                                                          | From                                                                         |
| ------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Durable thread state            | the upstream checkpointer — `SqliteSaver` or `PostgresSaver` | skein selects it for the chosen storage ([storage.md](./storage.md))         |
| Trimming a long conversation    | `trimMessages`, `filterMessages`, `RemoveMessage`            | `@langchain/core`                                                            |
| Summarizing a long conversation | `summarizationMiddleware`, `contextEditingMiddleware`        | the `langchain` v1 package                                                   |
| Cross-thread memory store       | `getStore()` — namespace/key items, vector search            | skein injects it into every run                                              |
| Semantic search over memories   | `store.index` (pgvector, HNSW optional)                      | skein ([storage.md](./storage.md#drivers))                                   |
| Per-owner isolation             | an `@auth.on.store` handler that roots the namespace         | you ([agent-protocol.md](./agent-protocol.md#authentication--authorization)) |
| Scheduled background extraction | a cron firing an extractor graph                             | skein ([crons.md](./crons.md))                                               |
| Memory _shapes_, tools, dedup   | this page                                                    | your graph and application                                                   |

## Short-term memory is already solved

**Durability** is the checkpointer. `SqliteSaver` or `PostgresSaver` persists a thread's state and history, so a
conversation survives restarts and resumes from an interrupt; thread TTL collects the ones that go stale.
Select durable storage when you need conversations to survive a restart.

Choose [SQLite](./local-deployment.md) for one local Node owner, or Postgres for a server. SQLite
supplies text/filter search; semantic recall requires Postgres indexing or an external semantic store.

**Context management** — keeping a long thread inside the model's window — is upstream too:

With your existing `model` and `tools`, add summarization middleware:

```ts
import { createAgent, summarizationMiddleware } from "langchain";

const agent = createAgent({
  model,
  tools,
  middleware: [
    summarizationMiddleware({ model, trigger: { tokens: 4000 }, keep: { messages: 20 } }),
  ],
});
```

Keep a conversation summary in **graph state** rather than the store: state is checkpointed, thread-scoped, and rolls back with the checkpoint,
none of which is true of a store item.

## Long-term memory: profile and collection

Cross-thread memory is `getStore()` — namespace/key JSON documents, the same store LangGraph Platform
auto-provides. Two shapes cover almost everything, and the choice is really "one document or many":

**Profile** — one continuously-updated document. Good for stable facts with one current value: timezone,
tone, home airport. Read it whole, merge a patch, write it back.

**Collection** — many documents accumulated over time. Good for open-ended facts: "prefers morning
meetings", "allergic to shellfish". Append, and retrieve by relevance rather than reading all of them.

```ts
import type { BaseStore } from "@langchain/langgraph";

// Profile: read-modify-write one document.
async function mergeProfile(store: BaseStore, userId: string, patch: Record<string, unknown>) {
  const current = (await store.get([userId], "profile"))?.value ?? {};
  await store.put([userId], "profile", { ...current, ...patch });
}
```

This example uses a shallow merge: the patch wins, arrays and nested objects are replaced, and
`null` is stored as a value. Choose explicit deletion behavior if your profile needs it.

Two things to know:

- **There is no compare-and-swap.** `BaseStore` has none, so read-modify-write is last-writer-wins. On
  skein, runs on one thread are serialized by the execution lock, so updates from other threads or direct store clients can still race. Do not build an optimistic-retry counter — without CAS it does not close the
  race and implies a guarantee that is not there.
- **Keep collection fields top-level and scalar.** `search`'s `filter` reads the _top-level_ keys of an
  item's `value` and takes scalars, so `{ content, kind, createdAt }` filters and `{ meta: { kind } }`
  does not. `tags: string[]` is storable but not filterable (`$in` asks the opposite question). Full
  operator semantics in [storage.md](./storage.md#filtering-and-namespace-traversal).

## The dedup trap

If your agent saves a fact on every turn, repeated facts can overwhelm useful memories. Do not use
a similarity threshold until you have checked what search scores mean for your backend:

| Substrate                                              | `score` on a text search |
| ------------------------------------------------------ | ------------------------ |
| `@skein-js/storage-memory` without an index            | **`1` for every hit**    |
| `@skein-js/storage-postgres` **without** `store.index` | **`1` for every hit**    |
| `@skein-js/storage-postgres` **with** `store.index`    | real cosine similarity   |
| LangGraph `InMemoryStore` without an index             | no `score` field at all  |

For a backend that returns `1` for every hit, `score >= 0.9` would treat unrelated facts as duplicates
and discard them.

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

This example uses the Web Crypto API available on supported Node.js versions, Bun, and Deno.

**2. Treat semantic dedup as opt-in, requiring `store.index`.** And check the scores are meaningful before
trusting them — at least one candidate scoring **strictly below 1** — falling back to exact dedup
otherwise. State the safe direction out loud: **dedup errs toward writing.** A duplicate is recoverable;
a dropped memory is not.

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

Decide whether memory belongs to a user, a team, or the whole application. For per-user memory,
verify that a second user cannot read the first user's namespace.

`prefix`, `suffix` and `filter` are **request parameters, not access control**. An omitted prefix matches
every namespace. The control is an **`@auth.on.store` handler** that rewrites `value.namespace` to root the
caller — LangGraph's own idiom, and skein honours it. See
[agent-protocol.md](./agent-protocol.md#authentication--authorization).

It covers the HTTP surface. **`getStore()` inside a graph has no request and no principal**, so nothing
guards it for you. Build its namespace from `config.configurable.langgraph_auth_user_id` when using skein's authentication
integration, never from model output. Use the same safe identity encoding as your HTTP authorization
handler; see [store scoping](./agent-protocol.md#scoping-the-store) for its constraints.

To verify your setup, save a preference in one thread and read it from a new thread for the same user.
Then repeat as another user and expect no access. With durable storage, repeat after a restart. See
[project persistence checks](./testing-your-project.md#check-state-across-turns-and-restarts).

## Writing memories in the background

Extracting memories inline costs the user's turn a model call. Two ways to move it off the hot path, both
use existing graph and run APIs:

**A cron.** Point a [schedule](./crons.md) at an extractor graph that you write and register:

```jsonc
{ "graphs": { "agent": "./src/agent.ts:graph", "extract-memories": "./src/extract.ts:graph" } }
```

**A delayed follow-up run.** After a conversation turn succeeds, your application can schedule
extraction after a short delay. With an existing SDK `client` and source `threadId`:

```ts
await client.runs.create(null, "extract-memories", {
  afterSeconds: 30,
  input: { thread_id: threadId },
  metadata: { extractor: true },
});
```

The extractor must accept `thread_id` and read that conversation. Each call creates a separate run;
the delay does not debounce repeated requests. If you need cancellation, retain the returned run's
IDs and cancel that run rather than searching the source conversation's runs.

Use durable storage and queue configuration when scheduled work must survive a restart. Verify
that the extractor writes the expected fact once and that the next conversation recalls it. Your
application chooses when extraction should happen after failures or cancellation.

## See also

- [storage.md](./storage.md) — the store itself: drivers, `getStore()`, filters, TTL, scoping, BYO store
- [crons.md](./crons.md) — schedules, for the cron extraction pattern
- [`examples/chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app) — a working research assistant with memory and recall
- [LangChain's memory guide](https://docs.langchain.com/oss/javascript/concepts/memory) — the
  profile/collection framing this page builds on
