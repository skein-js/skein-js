# Proposal — Agent memory primitives

> **Status:** **Resolved.** The infrastructure shipped; the primitives deliberately did not · **Depends
> on:** nothing · **Unblocks:** nothing (it is a leaf)
>
> Kept as history, and because two of its central claims turned out to be wrong in ways worth recording.
> The shipped behaviour lives in [storage.md](../storage.md) and [memory.md](../memory.md); what remains
> here is the argument, including the parts of it that did not survive contact.
>
> **What shipped**
>
> | Phase                                                              | Outcome                                                                           |
> | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
> | 1 — traversal plumbing (`filter`, `suffix`/`max_depth`, wildcards) | ✅ Shipped, plus the SDK response-shape bug found while fixing it                 |
> | 4 — store adapter (`store.adapter` + `fromBaseStore`)              | ✅ Shipped — see [storage.md](../storage.md#bringing-your-own-store-storeadapter) |
> | per-owner store scoping (a risk in this doc, not a phase)          | ❌ **Built and removed.** The handler owns it — see the note below                |
> | 2 — memory shapes                                                  | ❌ **Not built as a package.** Shipped as a recipe: [memory.md](../memory.md)     |
> | 3 — background extraction                                          | ⏸ **Deferred**, with reasoning below                                              |
>
> **Two claims here are wrong, and the second one badly**
>
> 1. _"Background extraction is the part only a server can offer."_ False against a user of skein's own
>    API. Delayed runs are store rows, pending runs are cancellable, and an embedder can call
>    `runs.createStatelessBackground` directly — so a debounced, durable extractor is buildable today with
>    no new surface (the pattern is in [memory.md](../memory.md#writing-memories-in-the-background)). What a
>    server-side trigger would add is config-instead-of-code, the correct hook point, a self-trigger guard
>    and telemetry. Ergonomics over an existing capability, which is why it is deferred rather than built.
>    The one genuine capability gap: a graph node cannot know its own run _settled_, so error and
>    cancellation paths are unreachable from inside the graph.
> 2. _"`filter` on `value` and a `StoreRepo` seam make scoping tractable."_ The design sketched here for
>    Part 3 would have shipped a **cross-tenant read**. LangGraph's `InMemoryStore` matches namespace
>    prefixes as a raw _string_ (`namespace.join(":").startsWith(prefix.join(":"))`), so a scope root of
>    `["@u","alice"]` also matches `["@u","alice2", …]`. A forwarding adapter plus namespace scoping is a
>    leak. `fromBaseStore` therefore **re-imposes** skein's semantics in JS rather than forwarding them —
>    which is also why a bare `InMemoryStore` can pass the shared conformance suite at all.
>
> **Why the primitives became a recipe.** Memory is agent behaviour, not durable persistence, and a user
> can build the shapes in ~100 lines over the `getStore()` skein already injects. LangChain has since
> closed the short-term half of this upstream — `summarizationMiddleware` and `contextEditingMiddleware`
> exist in the `langchain` v1 package — **as middleware**, which is framework code running inside the
> user's graph. That is where the long-term half will arrive too, and it is not a server's job. There is
> still no JS `langmem`, so the gap named below is real; it is simply not skein's to fill.

## Contents

- [Problem](#problem)
- [What we hope to achieve](#what-we-hope-to-achieve)
- [Non-goals](#non-goals)
- [Prior art — what LangGraph gives, and what it leaves to you](#prior-art--what-langgraph-gives-and-what-it-leaves-to-you)
- [Design](#design)
  - [Part 1 — Memory shapes: profile and collection](#part-1--memory-shapes-profile-and-collection)
  - [Part 2 — Background writes, on the run lifecycle](#part-2--background-writes-on-the-run-lifecycle)
  - [Part 3 — Bring your own store](#part-3--bring-your-own-store)
- [Configuration](#configuration)
- [Alternatives considered](#alternatives-considered)
- [Risks and open questions](#risks-and-open-questions)
- [Success criteria](#success-criteria)
- [Phasing](#phasing)

## Problem

skein gives you a store. LangGraph gives you a store. Neither gives you **memory**.

The gap is not storage and it is not query syntax — it is that every team building an agent
re-implements the same three things by hand on top of namespace/key CRUD:

1. **A shape.** [LangChain's own memory guide](https://docs.langchain.com/oss/javascript/concepts/memory#long-term-memory)
   names the choice — a **profile** (one continuously-updated JSON document) or a **collection**
   (many documents accumulated over time) — and is candid that both are awkward: a profile grows
   error-prone as it fills, and a collection makes you handle deletion, dedup, and "how do I give the
   model all of this" yourself. Everyone writes that reconciliation logic, and everyone writes it
   slightly differently.
2. **A namespace convention.** `[userId, context]` is the documented idiom, but it is a _convention_ —
   nothing enforces it, nothing helps you traverse it, and getting it wrong is discovered late.
3. **A trigger.** The guide splits writing into **hot path** (inline, adds latency, needs a tool call)
   and **background** (no latency, cleaner separation) — and then says the hard part of background
   writing is _"determining update frequency and triggering mechanisms."_ That is left entirely to
   the reader.

Point 3 is the one that matters most here, because **it is a scheduling problem, and skein already
owns the scheduler.**

Python's `langmem` is the reference answer, and it is worth being precise about what it does and does
not solve, because the distinction is the whole argument. It **does** solve triggering, with a design
worth copying: `ReflectionExecutor.submit(payload, after_seconds=delay)` keeps a queue of pending
tasks **per thread** and **cancels the pending one when a new message arrives** before the delay
expires — so extraction runs once when a conversation pauses rather than once per turn.

What it does not solve is **durability**. That executor is in-process; its docs concede that _"local
threads terminate between serverless function invocations"_ and say nothing about pending work when a
process dies. The durable form is a remote executor pointed at a server:

```python
ReflectionExecutor("my_memory_manager", ("memories",), url="http://localhost:2024")
```

That `url` is a LangGraph server. So the honest framing is not "a library cannot do this" — it is
that **langmem's background memory is durable only when a server backs it, and today that server is
LangGraph Platform.** Which is precisely the dependency skein exists to replace, on precisely the
port `skein dev` already serves. See [Alternatives](#alternatives-considered) for the question that
raises.

There is no JavaScript `langmem`. Verified: every published example is `from langmem import …`, and
no memory extraction, consolidation, or reflection utilities exist under `@langchain/*` for JS. An
unaffiliated `langmem-ts` exists on npm at v0.1.0; it is not LangChain's and is not prior art. So
there is nothing to reuse at this layer, and nothing that makes this redundant.

## What we hope to achieve

- **G1 — A user writes a memory without inventing a schema.** Profile and collection are first-class
  shapes, not patterns you re-derive from a docs page.
- **G2 — Memory is traversable, not just searchable.** Hierarchical namespaces you can walk, and
  cross-namespace retrieval that narrows by content — so an agent pulls the ten memories that matter
  instead of scanning a namespace.
- **G3 — Writing memory costs the user's turn nothing.** Extraction happens after the run settles,
  on machinery skein already runs, with no latency added to the reply.
- **G4 — The substrate stays swappable.** Someone with an existing vector store or LangGraph
  `BaseStore` can keep it and still get the primitives above.
- **G5 — Nothing here is mandatory.** A graph that wants raw `getStore()` keeps working exactly as
  it does now; these are primitives offered, not a layer imposed.

## Non-goals

- **skein calling an LLM itself.** It never has, and it should not start. Extraction runs as a
  _graph the user supplies_ — see [Part 2](#part-2--background-writes-on-the-run-lifecycle). That
  keeps model choice, keys, prompts and cost in the user's hands, and adds no model dependency to
  the server.
- **Prompt-authoring for extraction.** We supply the trigger and the plumbing, not opinions about how
  to summarize a conversation.
- **Procedural memory / self-modifying prompts.** The third type in LangChain's taxonomy. It is a
  graph-authoring pattern, not a persistence primitive, and nothing in skein blocks it today.
- **Replacing the checkpointer.** Graph state and history stay LangGraph-native. This is only
  cross-thread memory.
- **A memory _service_ integration (Mem0, Zep, Letta).** Those are opinionated pipelines, not stores;
  see [Alternatives](#alternatives-considered).

## Prior art — what LangGraph gives, and what it leaves to you

**Given:** `BaseStore` — namespace/key items, optional vector index, `search(prefix, { query,
filter })`, `listNamespaces({ prefix, suffix, maxDepth })`. Hierarchical organization is explicitly
the intended model: _"each memory is organized under a custom namespace (similar to a folder) and a
distinct key (like a file name)… cross-namespace searching is then supported through content
filters."_

**Left to you:** everything above the substrate. Profile-vs-collection is described in prose and
never in code. Background writing is described as a good idea with an unsolved trigger. The reference
material is two GitHub templates (`memory-agent`, `memory-service`) — i.e. _copy this repo_, which is
the clearest possible signal that the primitive is missing.

**Two things skein had to fix to make G2 real** — both parity gaps that existed regardless of this
proposal, and both now **shipped** (Phase 1, see [Phasing](#phasing)):

- ~~`POST /store/items/search` accepts a `filter` and **silently discards it**.~~ `filter` now reaches
  both drivers, pushed into SQL on Postgres so a page is a page of matches. An unknown operator or a
  non-scalar value is a 400 rather than a silent narrowing. Skein defines the semantics — LangGraph's
  engine is private — and the one deliberate divergence (ordering operators compare numbers only) is
  documented in [storage.md](../storage.md#filtering-and-namespace-traversal) and pinned by the
  conformance suite.
- ~~`POST /store/namespaces` has no `suffix` or `max_depth`, and a wildcard prefix returns **every
  namespace in the store**.~~ `StoreRepo.listNamespaces` now takes a `StoreNamespaceQuery`, which the
  old positional `(prefix, pagination)` pair could not express. `"*"` matches one segment
  positionally, `suffix` and `max_depth` are honoured, and the cross-tenant over-return is closed.

Fixing these also surfaced a third defect in the same handlers, likewise shipped: both endpoints
returned bare arrays where the SDK reads `.items` / `.namespaces`, and store items carried camelCase
timestamps where the SDK maps `created_at → createdAt`. So `client.store.searchItems()` threw outright
and every item arrived with `undefined` timestamps. A response-shape test now drives the real `Client`.

These were plumbing for the primitives, not the headline. But the primitives did not work without them.

## Design

### Part 1 — Memory shapes: profile and collection

A small library over the store skein already injects — importable in a graph node, working against
`getStore()` so it is portable to LangGraph Platform:

```ts
const memory = agentMemory(store, { userId });

// Profile: one document, reconciled rather than replaced.
await memory.profile.merge({ tone: "concise", timezone: "EAT" });
const who = await memory.profile.read();

// Collection: many documents, deduped on write, retrieved by relevance.
await memory.collection("facts").remember("Prefers morning meetings");
const relevant = await memory.collection("facts").recall("scheduling", { limit: 5 });
```

What the primitive owns, and why each is here rather than in user code:

- **Namespace construction.** `[userId, "profile"]` / `[userId, "facts"]` derived from one config,
  so the convention is enforced instead of remembered. This is what makes traversal work: a
  well-formed hierarchy is walkable with `listNamespaces({ prefix, maxDepth })`.
- **Merge semantics for a profile** — the "error-prone as it grows" problem, solved once, with a
  documented conflict rule instead of a per-project one.
- **Dedup on collection write** — the "handling deletion and updating of existing items" problem the
  guide names, using the store's own semantic search to detect a near-duplicate before appending.
- **Retrieval that narrows** — `recall()` is `search` with the namespace and filter already right.

The open design question is how much reconciliation belongs here without an LLM. Set-merge and
near-duplicate detection are mechanical; genuine contradiction ("lives in Nairobi" vs "lives in
Mombasa") is not, and resolving it needs a model — which is Part 2's job, not this one's.

### Part 2 — Background writes, on the run lifecycle

**This is the part only a server can offer, and the reason this proposal is worth more than a
library.**

The trigger problem LangChain leaves open — _when_ do you extract memories? — is a scheduling
problem. skein already settles runs, already has a queue, already has a worker, and already has a
cron scheduler. So:

> When a run on this thread settles, start a run of the **extractor graph** with the conversation as
> input, on the same machinery every other background run uses.

No new execution path, no new worker, no model dependency. It is a run that creates a run — the same
shape as a cron firing one, and close to what `webhook` already does at the process boundary, pointed
inward instead of outward.

Declared per-assistant in config:

```jsonc
{
  "graphs": { "agent": "./src/agent.ts:graph", "extract-memories": "./src/memory.ts:graph" },
  "store": {
    "memory": {
      "extractor": "extract-memories", // a graph id, not a path — it is a normal graph
      "on": "run_settled", // later: "every_n_turns", a cron expression
      "namespace": ["{user_id}", "facts"],
    },
  },
}
```

Why an ordinary graph rather than a skein-authored extractor: the user picks the model, holds the
key, writes the prompt, and can test it with `skein dev` like any other graph. skein contributes the
one thing it uniquely has — reliable, at-least-once, cross-instance triggering — and contributes no
opinions about prompting.

**Debounce, borrowed from `ReflectionExecutor`.** Firing on every settled run extracts from
fragments and pays for a model call per turn. langmem's answer is the right one: hold the extraction
for `after_seconds`, and **cancel the pending one when the next run starts on that thread**, so it
fires once when the conversation pauses. skein can express that natively — `after_seconds` is
already an honoured run-create option (shipped in 0.13.1, backed by the queue's `delayMs`), and
"cancel the pending extractor for this thread" is a run cancel it already has. So this costs
scheduling glue, not new machinery.

Unlike `ReflectionExecutor`'s in-process queue, a delayed run is a **row in the store**, so a pending
extraction survives the process that scheduled it. That is the durability gap in the Problem section,
closed by construction rather than by adding a second mechanism.

Sequencing note worth settling early: an extractor run must not be able to trigger itself. The
guard is the same shape as the cron scheduler's — mark the run so the trigger skips it — and it needs
to exist from the first commit, not after the first infinite loop.

### Part 3 — Bring your own store

Independently useful, and what keeps Parts 1–2 from being a lock-in.

`ProtocolDeps.store` is currently a whole `SkeinStore` — six repos. To put memory in Qdrant or an
existing LangGraph store you would have to implement assistants, threads, runs, crons and idempotency
too. Composing around it (`{ ...postgresStore, store: mine }`) is booby-trapped: `maxPageSize` and
`durable` are class getters, and object spread copies own enumerable properties only, so both
silently become `undefined` — the trap
[`auth-scoped-store.ts`](https://github.com/skein-js/skein-js/blob/main/packages/agent-protocol/src/auth/auth-scoped-store.ts) already
documents and works around by carrying `maxPageSize` explicitly.

So: make `store` independently injectable, following the telemetry pattern (a `ProtocolDeps` field
plus a `path:export` config key, loaded with the same `parseGraphSpec` + injectable `importModule` +
distinct `SkeinConfigError` discipline [`loadAuthEngine`](https://github.com/skein-js/skein-js/blob/main/packages/config/src/auth-engine.ts)
established and `resolveTelemetry` already copied — this would be the fourth use). Accept **either** a
`StoreRepo` or a LangGraph `BaseStore`, discriminating structurally on `"batch" in exported`, and
adapt the latter with `fromBaseStore` — the inverse of the `SkeinBaseStore` bridge we already have.

Two divergences make that adapter lossy, and both need a decision rather than a shrug:

| Divergence                                     | Why it hurts                                                                                                                                                      | Proposed resolution                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StoreRepo.put → Item`, `BaseStore.put → void` | The adapter must `put()` then `get()` to synthesize a return — an extra round trip, and racy: a concurrent write between the two returns the wrong item or `null` | Accept the read-back and document it. Widening `StoreRepo.put` to `void` would degrade the bundled drivers to serve the adapter, which is backwards                                                  |
| TTL is invisible through `BaseStore`           | `ttl` on put is dropped; `sweepExpired()` cannot be implemented                                                                                                   | Capability-detect (`"sweepExpiredItems" in store`, which is exactly how `PostgresStore` exposes it) and **refuse a configured `store.ttl` at startup** rather than accepting `ttl` and discarding it |

Worth knowing: `PostgresStore` from `@langchain/langgraph-checkpoint-postgres/store` is **already a
skein dependency**, and ships pgvector with HNSW _and_ IVFFlat, a `"text" | "vector" | "hybrid" |
"auto"` search mode, and TTL config fields byte-identical to skein's. Hybrid search is a capability
skein lacks. Reachable through this adapter for free once it exists.

## Configuration

Under `store`, beside the `index` and `ttl` blocks it already has — `store` is a LangGraph-owned key
and these are sub-keys of it, so no `skein.*` namespacing is needed:

```jsonc
{
  "store": {
    "adapter": "./src/my-store.ts:store", // Part 3 — a StoreRepo or a BaseStore
    "memory": { "extractor": "extract-memories", "on": "run_settled" }, // Part 2
    "index": { "embed": "openai:text-embedding-3-small", "dims": 1536 },
    "ttl": { "default_ttl": 43200 },
  },
}
```

## Alternatives considered

**Ship nothing; point at the reference templates.** The status quo, and the honest baseline —
LangChain's own answer is "copy `memory-agent`". Rejected because a template is not a primitive: it
is forked, drifts, and every fork re-solves dedup and triggering. That is precisely the class of
plumbing skein exists to absorb.

**Write a JS `langmem` — extraction prompts and all.** Tempting given none exists. Rejected because it
puts skein in the business of prompting and model selection, which is the user's domain and a
permanent maintenance surface. Part 2 gets most of the value by supplying the trigger and letting the
user supply the graph.

**Be `langmem`'s remote executor instead of building our own trigger.** The sharpest alternative, and
it deserves a real answer. langmem's durable path is
`ReflectionExecutor("manager", ("memories",), url="http://localhost:2024")` — a **LangGraph server
URL**, on the port `skein dev` already serves. If that remote protocol is just run-create against a
named graph, skein may already satisfy it, or be one shim away, and Python users would get a durable
executor without LangGraph Platform. That is a strong drop-in story and squarely on-mission.

Two reasons it is not the plan here, neither of them fatal:

1. **It serves Python users, not skein's.** skein is the TypeScript story; a JS caller has no
   `langmem` to point at us in the first place.
2. **The remote protocol is undocumented on the page that mentions it.** Whether it is plain
   run-create or something Platform-specific is unverified, and the answer decides whether this is a
   shim or a reimplementation.

Worth an afternoon of investigation before Part 2 is scheduled: if skein already satisfies it, that
is a roadmap row LangGraph Platform cannot match, earned almost for free. **Open.**

**Do the trigger with the existing cron resource instead of a new hook.** Genuinely close — a cron
firing an extractor graph nightly is already possible today with no changes. Worth documenting as the
zero-work version, and it may be enough for some. It cannot express "after this thread's run
settles", which is the low-latency case.

**Adapt a memory service (Mem0/Zep) into `StoreRepo`.** Rejected on shape. Those services do not offer
namespace/key CRUD with prefix listing; an adapter would misrepresent `/store/items` or fail half of
it. If we want first-party support, the honest form is a recipe for calling one from a graph node,
which needs nothing from skein.

**Put the seam on `BaseStore` instead of `StoreRepo`.** Rejected: `StoreRepo` is what `/store/items`
is written against, it carries TTL that `BaseStore` cannot express, and its prefix matching is
segment-wise where `InMemoryStore`'s is a raw `join(":")` string prefix (so searching `["user"]`
matches `["users","123"]`). Adapting inward loses less than adapting outward.

## Risks and open questions

- **What does "traversed quickly" mean, exactly?** This proposal reads it as _hierarchical namespaces
  you can walk, plus filtered cross-namespace retrieval_ — the model the linked guide describes. If
  the intent is instead **linked/graph memory** — entities with relations, walked by edge rather than
  by namespace — that is a materially different design (an edge store, traversal queries, probably a
  different substrate) and this proposal does not cover it. **The one fork worth settling before
  anything is built.**
- **Per-tenant scoping is the sequencing risk.** `createAuthScopedStore` returns `inner` unchanged
  for `store` — memory is gate-only, with no ownership filtering (a documented Depth-2 follow-up).
  Tolerable for a store skein owns; materially worse advice once we are actively encouraging
  per-user memory namespaces and inviting external stores. **I lean toward scoping landing first.**
- **How much reconciliation without a model?** Set-merge and near-duplicate detection are mechanical.
  Contradiction is not. Drawing that line badly makes the profile primitive feel magical and
  unpredictable.
- **Extractor cost is invisible.** Every settled run silently starting another run doubles run
  volume, and the user pays for the model calls. Needs to be opt-in per assistant, observable in
  telemetry, and probably rate-limited — a `every_n_turns` mode may matter more than `run_settled`.
- **Filter semantics are ours to define.** _Settled in Phase 1._ LangGraph's `compareValues` engine is
  private with no `.d.ts`, so `filter` is a reimplementation matched by inspection. The rule chosen:
  ordering operators compare **numbers only**, because upstream's `Number()` coercion is not
  reproducible in Postgres (`'abc'::numeric` throws where `Number("abc")` yields `NaN`) and would make
  `true > 0` and `null >= 0` true. The conformance suite pins _our_ behaviour on both drivers but still
  cannot detect upstream drift.

## Success criteria

1. A graph node stores and retrieves a user profile and a fact collection through the primitive,
   with no hand-written namespace strings and no reconciliation logic in user code.
2. ✅ An SDK client's `filter` narrows a search on both drivers; an unsupported operator is refused
   rather than ignored.
3. ✅ `listNamespaces` honours `suffix`/`max_depth`, and a wildcard prefix narrows — pinned by
   conformance cases that failed before the change.
4. A settled run triggers an extractor graph, the reply's latency is unchanged, and an extractor run
   cannot trigger itself.
5. `store.adapter` pointing at a bare `InMemoryStore` from `@langchain/langgraph` serves the full
   `/store/*` surface with the shared conformance suite green — and the same config with `store.ttl`
   **fails at startup** rather than discarding `ttl`.
6. Swapping only `store` leaves `maxPageSize` and `durable` intact, by construction.

## Phasing

1. ✅ **Traversal plumbing** — `filter`, `suffix`/`max_depth`, the wildcard over-return (plus the SDK
   response shape, found while fixing them). Parity work, independently valuable, and a prerequisite
   for anything calling itself traversable. **Shipped** ahead of the rest being agreed — it fixed a
   silently dropped request field and a cross-tenant over-return of namespace names.
2. ❌ **Memory shapes** — **not built.** Shipped as [memory.md](../memory.md) plus content-addressed
   dedup in `examples/chat-app`. See the status block at the top for why.
3. ⏸ **Background extraction** — **deferred.** Buildable today with existing API; a server-side trigger
   is ergonomics over that, and if it lands it should be a _general_ lifecycle trigger rather than a
   memory feature, since "when a run settles, start this run" also serves evals and post-processing.
4. ✅ **Store adapter** — injection seam plus `fromBaseStore`. **Shipped**, and it landed second rather
   than last: LangChain's own JS guide tells users to build on `PostgresStore`, which skein could not
   accept, making this a drop-in gap rather than an extensibility nicety. Step 1's `StoreNamespaceQuery`
   did make it easier, as predicted — it lines up with `BaseStore.listNamespaces`' own options bag.

Also attempted, from the [risks](#risks-and-open-questions) section rather than the phasing: **per-owner
store scoping** (`store.scope`), which prepended an opaque per-owner namespace root. It was built, reviewed
hard, and **removed** — and why is the most useful thing in this document.

The root has to come from _somewhere_, and every source was wrong. Derived from the route's ownership
filters, it depended on which door the caller came through: a `/store/items` request scoped by the `store`
handler's answer while a run created through a `threads` route scoped by the `threads` handler's, so
divergent handlers filed a graph's memory under one root and the same owner's own read under another.
Derived instead from a dedicated `store` authorize, it became route-independent but changed _authorization
semantics_ as a side effect — the store handler fired on `POST /threads`, and a hard-coded action meant a
handler denying `search` began denying everything. Two attempts, two real defects, in opposite directions.

The premise was the problem. **Scoping is policy, and policy belongs to the deployment.** Whether a root is
per-user, per-tenant or a shared team subtree, and how an identity encodes into a namespace label, are
things a deployment knows and skein does not — the `$contains` refusal was an early signal of exactly that,
a setting discovering it could not express what a handler expresses trivially. LangGraph gets this right by
leaving it in the handler, so the mechanism skein keeps is the one LangGraph documents — honouring a
handler's `value.namespace` rewrite — and the setting is gone.

What that leaves open, stated rather than papered over: `getStore()` inside a graph has no request and no
principal, so no handler can guard it. A graph builds its own namespace from
`configurable.langgraph_auth_user_id`, which is server-injected and unspoofable, and that is the seam.
