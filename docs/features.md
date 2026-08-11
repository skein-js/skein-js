# Features

What skein-js can do, in one page. Find the row that matches what you're trying to build, then follow
the link. ✅ ships today · ⚠️ preview · 🗺️ planned.

Comparing against LangGraph Platform specifically? [roadmap.md](./roadmap.md) has the same ground
organised by parity instead.

## Run agents

| Capability                                                                              | Status | What it gets you                                                                   |
| --------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| [Background jobs](./background-jobs.md)                                                 | ✅     | Fire-and-forget work: hand skein a job, get an id back, hear the result by webhook |
| [Background runs](./runs.md)                                                            | ✅     | Return immediately, let the graph keep working, join the stream later              |
| [Wait / stream runs](./runs.md)                                                         | ✅     | Hold the connection for the answer, or stream tokens as they're produced           |
| [Stateless & batch runs](./runs.md)                                                     | ✅     | One-shot calls with no conversation to keep; up to 100 runs per request            |
| [Multitask / double-texting](./runs.md#multitask-what-happens-to-the-run-already-going) | ✅     | Decide what a second message does to the run already going — all four strategies   |
| [Cancel & rollback](./runs.md#cancelling)                                               | ✅     | Stop a run, keeping its writes or discarding them                                  |
| [Run timeouts](./runs.md#bound-a-runaway-run)                                           | ✅     | Bound a graph that hangs, instead of losing a worker slot                          |
| [Idempotent run creation](./agent-protocol.md#idempotent-run-creation-idempotency-key)  | ✅     | A retrying caller can't start the same run twice. No LangGraph Platform equivalent |
| [Cron schedules](./crons.md)                                                            | ✅     | Fire a graph on a schedule, exactly once across instances, no leader election      |
| [A graph as a plain endpoint](./serving-a-single-graph.md)                              | ✅     | `POST /invoke/:graph_id` — body in, final state out, no threads or runs            |

## Hold a conversation

| Capability                                                            | Status | What it gets you                                                                      |
| --------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| [Threads](./threads.md)                                               | ✅     | Conversations that persist, addressable by your own key (a ticket id, a phone number) |
| [Streaming (SSE)](./streaming.md)                                     | ✅     | Tokens, tool calls and reasoning as they happen — including a true `events` mode      |
| [Reconnect & join](./streaming.md)                                    | ✅     | Resume a dropped stream, or tail the same run from a second client                    |
| [Human-in-the-loop](./human-in-the-loop.md)                           | ✅     | Pause for approval and resume hours later, from anywhere                              |
| [Time travel](./threads.md#time-travel-re-run-a-turn-a-different-way) | ✅     | Fork from any past checkpoint and run forward — "edit and resubmit"                   |
| [Thread state & history](./threads.md#read-the-state)                 | ✅     | Read, patch, page, copy or prune a conversation's state                               |
| [Thread TTL](./storage.md#thread-ttl)                                 | ✅     | Expire conversations automatically. LangGraph OSS ignores `ttl`; skein doesn't        |
| [Assistants & versioning](./assistants.md)                            | ✅     | Ship a prompt change without redeploying, and roll it back in one call                |
| [`useStream` and friends](./react-sdk.md)                             | ✅     | The LangChain client ecosystem works unchanged — React, Vue, Svelte, Angular          |

## Remember things

| Capability                                                                      | Status | What it gets you                                                        |
| ------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| [The store, via `getStore()`](./memory.md)                                      | ✅     | Memory that outlives a conversation, reachable from inside a graph node |
| [Semantic search](./storage.md)                                                 | ✅     | pgvector-backed recall, with optional HNSW indexing                     |
| [Filters & namespace traversal](./storage.md#filtering-and-namespace-traversal) | ✅     | Query memory by value, and walk namespaces with wildcards               |
| [Store TTL](./storage.md#store-item-ttl)                                        | ✅     | Expire memories, optionally refreshing on read                          |
| [Bring your own store](./storage.md#bringing-your-own-store-storeadapter)       | ✅     | Point skein at a LangGraph `BaseStore` or your own implementation       |
| [Memory patterns](./memory.md)                                                  | ✅     | Profile vs collection shapes, the dedup trap, recall, background writes |

## Connect it to the rest of your system

| Capability                                                                 | Status | What it gets you                                                                    |
| -------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| [Run-completion webhooks](./webhooks.md)                                   | ✅     | Be told a run finished — durably, so a receiver's redeploy doesn't lose the news    |
| [Signed callbacks](./webhooks.md#verify-a-callback-is-really-from-you)     | ✅     | Receivers can prove a callback is yours and reject replays. The verifier ships too  |
| [Deliveries & replay](./webhooks.md#see-what-a-callback-did-and-replay-it) | ✅     | See every attempt, and re-send one by hand when it never landed                     |
| [Custom auth](./agent-protocol.md#authentication--authorization)           | ✅     | LangGraph's `Auth` model, drop-in, with ownership filters pushed into the query     |
| [Telemetry sinks](./observability.md)                                      | ✅     | LangSmith, PostHog, OpenTelemetry — or your own `TelemetrySink`                     |
| [Inbound events](./proposals/inbound-events.md)                            | 🗺️     | Agents behind WhatsApp, Slack, or a GitHub webhook, without re-solving the plumbing |
| [MCP endpoint](./roadmap.md)                                               | 🗺️     | Expose your graphs as MCP tools                                                     |

## Operate it

| Capability                                              | Status     | What it gets you                                                                  |
| ------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| [The console](./console.md)                             | ✅         | A Studio equivalent at `/console` — no account, no tunnel. Off by default in prod |
| [Postgres + pgvector](./storage.md)                     | ✅         | The production storage driver, with automatic migrations                          |
| [Redis queue & pub/sub](./runs-and-redis.md)            | ✅         | Durable run queue and cross-instance streaming                                    |
| [Multi-instance](./deploy.md#scaling-past-one-instance) | ✅         | Atomic create guard, cross-instance cancel, per-thread execution claim            |
| [Errors & logging](./errors-and-logging.md)             | ✅         | What a failed run reports, and where — wire, log, and callback                    |
| [Deploy anywhere](./deploy.md)                          | ✅         | One image; guides for Cloud Run, Fly, Railway, Render, AWS, Kubernetes, a VPS     |
| [Performance tuning](./performance.md)                  | ✅         | Every knob in one table, plus symptom → knob triage                               |
| [Bun / Deno runtimes](./deploy.md)                      | ⚠️ preview | Fetch launchers and images ship; the runtime matrices must graduate each          |

## Build on it

| Capability                                         | Status | What it gets you                                                         |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| [Framework adapters](./using-skein.md)             | ✅     | Express, Fastify, NestJS, Next.js, native Fetch — standalone or embedded |
| [Embed a graph in code](./embedding.md)            | ✅     | No `langgraph.json`, no CLI — bring a compiled graph and mount it        |
| [Drop-in LangGraph CLI](./langgraph-cli-compat.md) | ✅     | `skein dev` for `langgraph dev`, with your `langgraph.json` unchanged    |
| [Scaffolding](./scaffolding.md)                    | ✅     | `npm create skein-js@latest` — a working project, no API key needed      |
| [Your own adapter](./building-an-adapter.md)       | ✅     | Put the handler table on any HTTP framework                              |
| [Your own agent runtime](./building-a-runner.md)   | ✅     | Serve the Agent Protocol from something that isn't LangGraph             |

## Deliberately not

- **WebSocket transport** — SSE covers the client UX and doesn't affect the React SDK.
- **`skein deploy` to a hosted platform** — self-hosted by design; there's no managed target.
- **Sub-minute cron schedules**, and **backfilling missed occurrences** — see
  [crons.md](./crons.md#semantics).
- **Exactly-once webhook delivery** — at-least-once with a stable dedup key. See
  [webhooks.md](./webhooks.md#at-least-once-and-what-your-receiver-owes).

Something missing? [File an issue](https://github.com/skein-js/skein-js/issues) — compatibility
reports are the most useful feedback we get.
