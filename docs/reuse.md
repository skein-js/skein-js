# Reuse-first architecture

> **Principle:** Reuse as much of the LangGraph open source as possible. Build only what
> LangGraph OSS does not already give us — and build that well.

LangChain publishes a large, **MIT-licensed** JavaScript ecosystem under
[`langchain-ai/langgraphjs`](https://github.com/langchain-ai/langgraphjs). Crucially — and
unlike the Python side that [aegra](https://github.com/aegra/aegra) had to reimplement from
scratch — the **JS Agent Protocol dev server itself is open source**
([`@langchain/langgraph-api`](https://www.npmjs.com/package/@langchain/langgraph-api), MIT).

So skein-js is deliberately _thin_. We stand on the OSS runtime, checkpointers, parser,
schemas, and SDK, and add only the **durable-production, multi-framework, drop-in-CLI**
layer that OSS does not provide.

## What skein-js reuses (dependencies, all MIT)

| Concern                       | LangGraph OSS package                        | How skein-js uses it                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph runtime                 | `@langchain/langgraph`                       | Run graphs via `CompiledStateGraph.invoke` / `.stream`; interrupts + resume for human-in-the-loop. Never reimplemented.                                                                                                                                                                                                   |
| Checkpoint base + dev saver   | `@langchain/langgraph-checkpoint`            | `BaseCheckpointSaver`, `MemorySaver` for dev.                                                                                                                                                                                                                                                                             |
| Postgres checkpoints          | `@langchain/langgraph-checkpoint-postgres`   | `PostgresSaver` for graph state in prod.                                                                                                                                                                                                                                                                                  |
| Redis checkpoints             | `@langchain/langgraph-checkpoint-redis`      | Optional Redis-backed checkpointer. (Note: distinct from `@skein-js/redis`, which is the run **queue**.)                                                                                                                                                                                                                  |
| SQLite checkpoints            | `@langchain/langgraph-checkpoint-sqlite`     | Optional file-backed dev checkpointer.                                                                                                                                                                                                                                                                                    |
| Checkpointer conformance      | `@langchain/langgraph-checkpoint-validation` | Reused as-is in our test suite to validate any checkpointer wiring.                                                                                                                                                                                                                                                       |
| **Agent Protocol dev server** | **`@langchain/langgraph-api`** (MIT)         | Reuse its public exports: `./schema` (the `langgraph.json` graph parser), `./auth` (auth-handler contract), `./experimental/embed` (embeddings for semantic store search). Its Zod request/response schemas and in-memory handler logic (MIT) are the reference we adapt for the durable drivers rather than reinventing. |
| CLI + config semantics        | `@langchain/langgraph-cli`                   | Reference for `langgraph.json` fields and `dev/up/build/dockerfile` behavior we mirror.                                                                                                                                                                                                                                   |
| Wire types + JS client        | `@langchain/langgraph-sdk`                   | **Reuse the SDK's TypeScript types** for Thread/Run/Assistant/etc. as our wire contract instead of regenerating; also our conformance oracle.                                                                                                                                                                             |
| React streaming               | `@langchain/langgraph-sdk/react`             | `useStream` — a target client we satisfy, not something we build. (`sdk-vue`, `sdk-svelte`, `sdk-angular` exist too.)                                                                                                                                                                                                     |
| Chat UI                       | `langgraph-ui` / Agent Chat UI               | Interop target for smoke tests.                                                                                                                                                                                                                                                                                           |

**Rule of thumb:** if a `@langchain/*` package already does it, we depend on it (as a
`peerDependency` where the consumer should own the version). We do not fork or vendor it.

## What skein-js rebuilds (the gap)

`@langchain/langgraph-api` is explicitly an **in-memory dev server** ("in-memory mode,
suitable for development and testing"), built on Hono and oriented around the CLI. It does
not aim to provide durable production infrastructure. That gap — the same one aegra fills
for Python — is skein-js's actual product:

| Gap in OSS                                                                               | skein-js package                                                 | Why it's needed                                                                                                                |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Durable persistence of **protocol resources** (assistants / threads / runs / store rows) | `@skein-js/storage-postgres` + `SkeinStore`                      | The OSS server keeps these in memory; production needs Postgres (+ pgvector). Graph _checkpoints_ still reuse `PostgresSaver`. |
| Durable **background-run queue** + **cross-instance pub/sub** streaming                  | `@skein-js/redis`                                                | The OSS server runs runs in-process; horizontal scaling needs a real queue and fan-out.                                        |
| **Framework-native adapters**                                                            | `@skein-js/express` (· `@skein-js/fastify` · `@skein-js/nestjs`) | The OSS server is Hono-only; teams want to mount the protocol into their existing Express/Fastify/Nest app.                    |
| **Normalized protocol core** tying runtime + checkpointer + store + queue together       | `@skein-js/core`                                                 | Adapter- and driver-agnostic handlers so behavior is identical everywhere.                                                     |
| **Drop-in production CLI**                                                               | `skein-js`                                                       | `skein dev/up/build/dockerfile` reading an unchanged `langgraph.json`, wiring the durable drivers.                             |
| **`langgraph.json` loading orchestration**                                               | `@skein-js/config`                                               | Thin wrapper over `@langchain/langgraph-api`'s `./schema` parser, adding `skein.json` overrides and driver selection.          |

## Consequences

- **Small surface, few bugs.** Most agent behavior lives in battle-tested LangChain code;
  skein-js's own code is persistence, transport, and wiring.
- **Version alignment.** Reused packages are `peerDependencies` so apps control the exact
  LangGraph version and avoid duplicate installs.
- **Upgrades are cheap.** When LangGraph ships new stream modes or schema fields, skein-js
  inherits them through the shared runtime/types instead of chasing them by hand.
- **Honest positioning.** skein-js is "aegra for TypeScript" — but lighter, because on JS the
  server internals are already open. We add production durability, not a second server.

See [code-practices.md](./code-practices.md) for how we keep the code we _do_ write small
and neat, and [storage.md](./storage.md) / [runs-and-redis.md](./runs-and-redis.md) for the
rebuilt pieces in detail.
