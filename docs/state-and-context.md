# State, context & persistence

What your agent knows, where each piece of it lives, and what survives a restart. This is the
building block everything else rests on — interrupts, time travel, memory and durability are all
consequences of it.

## The four bags, and which one you want

This is the single most common source of confusion, so start here. A run carries four separate
things, and they behave completely differently:

| You pass              | Goes to                         | Persisted?                        | Use it for                                                                  |
| --------------------- | ------------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `input`               | Your graph's **state channels** | **Yes** — checkpointed per thread | The turn itself: the new message, the document                              |
| `context`             | LangGraph's **runtime context** | Stored on the run, not the state  | Per-run facts the graph reads but shouldn't remember: a locale, a tenant id |
| `config.configurable` | The graph's **config**          | Stored on the run, not the state  | Knobs: which model, which prompt, a feature flag                            |
| `metadata`            | The **run/thread row**          | Yes, as searchable labels         | Finding things later — never read by the graph                              |

```ts
await client.runs.create(threadId, "agent", {
  input: { messages: [msg] }, // becomes state
  context: { locale: "en-GB" }, // available to nodes this run
  config: { configurable: { model: "fast" } }, // knobs
  metadata: { ticket: "T-1234" }, // searchable label
});
```

The rule of thumb: **if the agent should still know it next turn, it belongs in `input`.** Everything
else is per-run.

## State: what the agent knows right now

Your graph declares the shape — the channels — and each node returns a partial update. skein-js
doesn't define this; it's LangGraph's, unchanged. If the model is new to you,
[Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)
is the shortest path to it — and its advice to keep **raw data in state and format prompts inside
nodes** is worth following, because everything you put in state is what gets checkpointed.

The part that surprises people is that **updates go through reducers**. A channel that appends (the
usual `messages` reducer) _adds_ what you return rather than replacing it:

```ts
// appends to messages — it does not overwrite the list
return { messages: [new AIMessage("done")] };
```

That matters the moment you edit state by hand, from the API or the [console](./console.md): you're
writing through the same reducers, so writing `{ messages: [...] }` to fix a transcript will append,
not replace. Use `asNode` to attribute the write to a node whose reducer does what you intend.

## Checkpoints: what makes everything else work

LangGraph saves the state to a **checkpoint** at node boundaries — each superstep of the graph. That
single mechanism is what gives you:

- **Multi-turn conversations** — the next run on the thread resumes from the last checkpoint rather
  than starting empty.
- **[Human-in-the-loop](./human-in-the-loop.md)** — `interrupt()` parks on a checkpoint. The run
  ends; nothing holds a connection or a timer. Resuming reads the checkpoint back.
- **[Time travel](./threads.md#time-travel-re-run-a-turn-a-different-way)** — every checkpoint is
  addressable, so you can read one, fork it, and run forward from the branch.
- **Crash recovery** — a process that dies mid-run leaves a committed checkpoint behind.

> [!WARNING]
> **No checkpointer, none of the above.** Without one, each run starts empty, `interrupt()` has
> nowhere to park, and resume silently no-ops — the single most common way this goes wrong. `skein dev`
> configures one for you; in code, `embedInMemoryGraphs` / `embedPostgresGraphs` do.

Checkpoint history is readable and pageable — see [threads.md](./threads.md#read-the-state). It's
also the largest thing you store, which is why `POST /threads/prune` has a `keep_latest` strategy
that drops history while keeping current state.

## Short-term vs long-term: two different stores

The distinction people miss:

<div class="skein-cards">
<div class="skein-card">
<span class="ico">🧵</span>

### Short-term — the checkpointer

Scoped to **one thread**. Holds the conversation's state and its history. Written automatically by
the graph on every step; you rarely touch it directly.

</div>
<div class="skein-card">
<span class="ico">🗄️</span>

### Long-term — the store

Scoped to **whatever namespace you choose**, across every thread. Read and written explicitly by your
nodes via `getStore()`, with semantic search and TTL.

</div>
</div>

A user's name belongs in the store, not the thread — otherwise the agent forgets it the moment they
start a new conversation:

```ts
import { getStore, type LangGraphRunnableConfig } from "@langchain/langgraph";

// In a node, the store arrives on the config…
async function remember(state: State, config: LangGraphRunnableConfig) {
  await config.store?.put(["users", userId], "profile", { name: state.name });
}

// …and inside a tool, where there's no config argument, reach for getStore().
async function saveName(name: string) {
  await getStore().put(["users", userId], "profile", { name });
}
```

`getStore()` reads the run currently executing, so it has to be called inside the function — at
module scope there is no run yet and it throws.

Both reach the same store — skein bridges its own into every run as a LangGraph `BaseStore`, so
nothing here is skein-specific and the same graph runs unchanged on LangGraph Platform.

Full patterns — profile vs collection shapes, the dedup trap, recall — are in
[memory.md](./memory.md); the mechanism and drivers are in [storage.md](./storage.md).

## What actually persists, and where

| Thing                     | Stored in                          | Survives a restart?                 |
| ------------------------- | ---------------------------------- | ----------------------------------- |
| Graph state & checkpoints | The checkpointer                   | With Postgres, yes. In memory, no   |
| Threads, runs, assistants | The store                          | With Postgres, yes. In memory, no   |
| Long-term memories        | The store                          | With Postgres, yes. In memory, no   |
| Queued & delayed runs     | The queue                          | With Redis, yes                     |
| Pending webhook retries   | The queue (schedule) + store (row) | Row always; schedule needs Redis    |
| Live stream frames        | The event bus                      | No — replayable only while retained |

**In development** everything is in-memory and disappears on exit — except that `skein dev` snapshots
to `.skein/` so your threads survive a restart while you work. **In production**, use Postgres for
state and Redis for the queue. See [storage.md](./storage.md) and
[runs-and-redis.md](./runs-and-redis.md).

## Expiring what you don't need

State accumulates. Two TTLs bound it:

- **Thread TTL** (`checkpointer.ttl`) — expire whole conversations. A per-thread `ttl` overrides the
  default, and `null` pins a thread forever. [Details](./storage.md#thread-ttl)
- **Store TTL** (`store.ttl`) — expire individual memories, optionally refreshing on read.
  [Details](./storage.md#store-item-ttl)

Both are skein going past LangGraph OSS, which drops `ttl` on the floor.

## What you must get right

- **`input` is the only bag the agent remembers.** `context` and `configurable` are per-run. Putting
  a fact in `context` and expecting it next turn is the classic mistake.
- **Reserved `configurable` keys are stripped.** `thread_id`, `run_id`, `checkpoint_id`,
  `checkpoint_ns`, `langgraph_auth_user`, anything starting with `__` — the server owns these, so a
  client can't redirect a run to another thread or spoof the authenticated caller. Your own keys pass
  through untouched.
- **The authenticated user arrives in `configurable`**, not in `context` — as
  `langgraph_auth_user`, `langgraph_auth_user_id` and `langgraph_auth_permissions`, stamped
  server-side and unspoofable. Present only when [auth](./agent-protocol.md#authentication--authorization)
  is configured.
- **The store is not ownership-scoped by default.** An authenticated caller can read every tenant's
  items unless an `@auth.on.store` handler narrows it. See
  [scoping the store](./agent-protocol.md#scoping-the-store).
- **Big state is expensive.** Checkpoints hold the whole state per superstep, so a graph that keeps
  large blobs in a channel multiplies them. Keep artifacts in object storage and a reference in state.

## See also

- [Threads](./threads.md) — reading, editing, forking and expiring conversation state
- [Memory](./memory.md) — long-term memory patterns
- [Storage](./storage.md) — `SkeinStore`, drivers, TTL, bring-your-own
- [Human-in-the-loop](./human-in-the-loop.md) — what checkpoints make possible
- [Building a runner](./building-a-runner.md) — implementing state for a non-LangGraph runtime
