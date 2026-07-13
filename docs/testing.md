# Testing

> **Principle:** test behavior, not implementation. Fast unit tests for pure logic; real
> infrastructure (via Testcontainers) for anything that talks to Postgres or Redis. One
> shared contract suite so every driver behaves identically.

Runner: **[Vitest](https://vitest.dev)** across the whole workspace. Integration:
**[Testcontainers](https://testcontainers.com)** for ephemeral Postgres/Redis.

## The three layers

| Layer                       | Runs against                               | Where                                                  | Speed   |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------ | ------- |
| **Unit**                    | Pure functions, injected fakes             | co-located `*.test.ts` in every package                | ms      |
| **Integration (container)** | A **real** Postgres / Redis in a container | `*.integration.test.ts` in `storage-postgres`, `redis` | seconds |
| **Conformance**             | Every storage driver, one shared suite     | `@skein-js/test-support` → run in each driver package  | mixed   |

### 1. Unit tests — the default

Most code is pure by [design](./code-practices.md), so most tests need no infrastructure.
Inject fakes for collaborators; assert on returned data.

```ts
import { describe, it, expect } from "vitest";
import { toSSEFrame } from "./sse-frame.js";

describe("toSSEFrame", () => {
  it("serializes a messages event with a monotonic id", () => {
    const frame = toSSEFrame({ mode: "messages", payload: { content: "hi" } }, 7);
    expect(frame).toEqual({ id: "7", event: "messages", data: '{"content":"hi"}' });
  });
});
```

Target coverage for `@skein-js/agent-protocol` logic (run engine, SSE mapping) and `@skein-js/config`
resolution is high
— it's pure and cheap to cover. We do **not** chase a coverage number on glue/adapters.

### 2. Integration tests — real containers, where it makes sense

Anything whose whole job is talking to a database or queue is tested against the real thing,
not a mock. A shared helper boots a throwaway container per suite:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPostgres } from "@skein-js/test-support";
import { PostgresSkeinStore } from "./index.js";

describe("PostgresSkeinStore", () => {
  let pg: Awaited<ReturnType<typeof startPostgres>>;
  let store: PostgresSkeinStore;

  beforeAll(async () => {
    pg = await startPostgres(); // Testcontainers: real Postgres + pgvector
    store = await PostgresSkeinStore.connect(pg.url);
    await store.migrate();
  });
  afterAll(async () => {
    await store.close();
    await pg.stop();
  });

  it("persists a thread and reads it back", async () => {
    const created = await store.threads.create({ metadata: { user: "a" } });
    const found = await store.threads.get(created.thread_id);
    expect(found?.thread_id).toBe(created.thread_id);
  });
});
```

Guidelines:

- Container tests are **opt-in by file suffix** (`*.integration.test.ts`) so the fast unit
  loop (`pnpm test`) stays quick; CI runs both.
- One container **per suite** (`beforeAll`), reused across `it`s; always tear down in `afterAll`.
- Requires Docker running locally. If Docker is absent, integration suites are skipped with a
  clear message — never silently passed.
- Graph **checkpoints** are covered by reusing LangGraph's own
  `@langchain/langgraph-checkpoint-validation` suite against our checkpointer wiring — we
  don't re-test the savers themselves (see [reuse.md](./reuse.md)).

### 3. Conformance suite — one contract, every driver

The `SkeinStore` interface has a single behavioral contract. `@skein-js/test-support` exports a
factory that generates the full suite; each driver package runs it against its own instance:

```ts
// storage-memory/src/store.conformance.test.ts
import { runSkeinStoreConformance } from "@skein-js/test-support";
import { MemorySkeinStore } from "./index.js";

runSkeinStoreConformance("memory", () => new MemorySkeinStore());

// storage-postgres/src/store.conformance.integration.test.ts
import { runSkeinStoreConformance } from "@skein-js/test-support";
import { startPostgres } from "@skein-js/test-support";
import { PostgresSkeinStore } from "./index.js";

runSkeinStoreConformance("postgres", async () => {
  const pg = await startPostgres();
  return PostgresSkeinStore.connect(pg.url);
});
```

This is what guarantees the in-memory dev driver and the production Postgres driver are
truly interchangeable.

## End-to-end / protocol conformance

Beyond storage, the [`examples/express-basic`](../examples/express-basic) server is driven by
the **real `@langchain/langgraph-sdk` client** as the wire-format oracle: if
`client.threads.create()`, `client.runs.stream()`, and `client.runs.wait()` behave, the
protocol is right. The [`examples/react-usestream`](../examples/react-usestream) app is the
front-end signal for the SSE/`useStream` path. See the [roadmap verification table](./roadmap.md#verification).

## Layout & naming

- Co-locate tests with the code: `foo.ts` → `foo.test.ts`.
- Suffix container/db tests `*.integration.test.ts`; suffix cross-driver contract tests
  `*.conformance*.test.ts`.
- Name tests as sentences describing behavior.
- `@skein-js/test-support` is a **private, unpublished** package (`"private": true`) holding
  Testcontainers helpers and the conformance suite factory.

## Nx wiring

Tests run **through Nx**, not bare Vitest:

- Each project has a `vitest.config.ts` (unit; excludes `*.integration.test.ts`). The
  **`@nx/vite`** plugin infers the cached `test` target from it — `passWithNoTests` keeps
  test-less stubs green.
- Postgres/Redis packages add a `vitest.integration.config.ts` and a `test-integration`
  target in `project.json` (`nx:run-commands`), kept **uncached** since it depends on a live
  container.

## Commands

| Command                                               | Does                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm test`                                           | `nx run-many -t test` — unit + conformance (memory), fast, no Docker.      |
| `pnpm test:integration`                               | `nx run-many -t test-integration` — `*.integration.test.ts`, needs Docker. |
| `pnpm test:coverage`                                  | `nx run-many -t test --coverage` (`@vitest/coverage-v8`).                  |
| `nx test <project>` / `nx test-integration <project>` | A single project.                                                          |
| `pnpm affected`                                       | Only projects affected by your changes.                                    |
