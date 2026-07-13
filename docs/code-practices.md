# Code practices

> **Goal:** code that is kind to your future self — readable, simple, and neat. When in
> doubt, choose the version that is easier to *read*, not the one that is clever to write.

These are conventions, not dogma. They exist so the codebase stays small and legible while
we lean on [LangGraph OSS](./reuse.md) for the heavy lifting.

## 1. Readability first

- **Name things for what they are.** `pendingRun`, not `pr`. `resolveGraph`, not `rg`. A
  good name removes the need for a comment.
- **Small functions, one job each.** If you need "and" to describe a function, split it.
- **Shallow nesting.** Prefer early returns / guard clauses over `else` ladders.
- **Comments explain *why*, not *what*.** The code says what. Reserve comments for intent,
  trade-offs, and links to spec/issues.
- **Match the surrounding style.** Consistency beats personal preference in a shared file.

```ts
// ❌ clever, dense
const t = xs.filter(x => x.s === "p").map(x => x.id).find(id => q.has(id));

// ✅ plain, obvious
const pendingRuns = runs.filter((run) => run.status === "pending");
const nextQueuedId = pendingRuns.map((run) => run.id).find((id) => queue.has(id));
```

## 2. Functional programming (default style)

We favor a functional, data-in/data-out style. It makes code easy to test and reason about.

- **Pure functions by default.** Same input → same output, no hidden side effects. Push I/O
  (DB, network, SSE writes) to the edges; keep the core pure.
- **Immutability.** Don't mutate inputs. Return new values (`map`/`filter`/`reduce`, spread,
  `structuredClone` when needed) instead of reassigning fields in place.
- **Composition over inheritance.** Build behavior from small functions and plain objects.
  Reserve classes for genuine stateful resources (a connection pool, a queue client) and
  keep them thin.
- **Explicit dependencies.** Pass collaborators in (a `SkeinStore`, a checkpointer, a clock)
  rather than importing singletons. This is what makes the [core](./index.md) adapter- and
  driver-agnostic and trivially testable.
- **Model absence and errors in the return type** where it aids clarity — a discriminated
  union / `Result`-like shape for expected failures; throw only for truly exceptional cases.

```ts
// ✅ pure transform, dependencies passed in
function toSSEFrame(event: StreamEvent, seq: number): SSEFrame {
  return { id: String(seq), event: event.mode, data: JSON.stringify(event.payload) };
}

// ✅ side effects live at the edge, injected
async function runInEngine(deps: { store: SkeinStore; graph: CompiledGraph }, input: RunInput) {
  const run = await deps.store.runs.create({ status: "pending", input });
  // ...pure decisions in between...
  return run;
}
```

Pragmatism note: functional style is the default, not a religion. A short local `for...of`
loop or a small mutable accumulator inside a single function is fine when it's clearer than
a chain of `reduce`s. Optimize for the reader.

## 3. Keep it simple & neat

- **YAGNI.** Build what the current milestone needs. Don't add config knobs, abstraction
  layers, or "future-proofing" nobody asked for.
- **Prefer reuse over reinvention.** Before writing something, check whether a
  `@langchain/*` package already provides it — see [reuse.md](./reuse.md). The best code is
  the code we didn't write.
- **One obvious way.** Avoid two helpers that do nearly the same thing. Delete dead code
  immediately; git remembers it.
- **Flat module layout.** Group by feature (`runs/`, `threads/`, `store/`), not by kind
  (`types/`, `utils/`). Keep a package's public surface in its `src/index.ts`.
- **Types are documentation.** Prefer precise types over `any`; `noUncheckedIndexedAccess`
  is on. Let the types make illegal states unrepresentable.

## 4. Codified conventions

These are the **decisions**, not preferences — enforced by tooling where possible so nobody
has to argue them in review.

### Language & modules

- **TypeScript strict** across the workspace (`tsconfig.base.json`), `noUncheckedIndexedAccess` on.
- **ESM only** (`"type": "module"`); use `import`/`export`, never `require`.
- **Named exports only.** No default exports in `packages/*` (enforced by `import/no-default-export`).
  *(Exception: the `examples/react-usestream` Next.js app, where the framework requires default
  exports for pages/layouts — scoped off in ESLint config.)*
- **One public surface per package:** everything consumers use is re-exported from `src/index.ts`.

### Files & naming

- **Filenames:** `kebab-case.ts` (`run-engine.ts`, `sse-frame.ts`).
- **Types/interfaces/classes:** `PascalCase`. **Values/functions:** `camelCase`.
  **Constants:** `UPPER_SNAKE_CASE` only for true module-level constants.
- **Layout by feature, not by kind:** `runs/`, `threads/`, `store/` — not `types/`, `utils/`.
- **No barrel files** beyond each package's `src/index.ts`.

### Functional style (see §2)

- Pure core, dependencies injected. Thin classes **only** for stateful resources
  (a `pg` pool, a Redis/queue client). Everything else is functions + plain data.
- Immutability by default; don't mutate inputs.

### Validation & errors

- **Validate at boundaries with [Zod](https://zod.dev).** Every inbound HTTP body / config
  file / env is parsed through a Zod schema at the edge; the interior trusts its types.
  (This aligns with `@langchain/langgraph-api`, which also uses Zod — see [reuse.md](./reuse.md).)
- **Errors:** throw typed error classes (e.g. `SkeinHttpError` with a `status`) at the edges;
  interior functions return plain values. Reserve throwing for exceptional/programmer-bug cases.

### Tooling

- **ESLint (flat config) + Prettier** are the source of truth for style, **run through Nx**
  — never bare `eslint`/`prettier`. `eslint.config.mjs` and `.prettierrc.json` live at the
  repo root; `@nx/eslint` infers the `lint` target, and formatting is Nx's built-in Prettier.
  Prettier owns whitespace; ESLint owns correctness/imports. Don't hand-argue style.
- **`pnpm lint` (`nx run-many -t lint`) / `pnpm format` (`nx format:write`)** must be clean
  before pushing.

### Commits & PRs

- **[Conventional Commits](https://www.conventionalcommits.org):** `feat:`, `fix:`, `docs:`,
  `refactor:`, `test:`, `chore:`, scoped where useful (`feat(core): …`).
- **Small, focused commits/PRs** with a clear message: *what changed and why*.

## 5. Testing

Full strategy in **[testing.md](./testing.md)**. In short:

- **Vitest** everywhere; test files co-located as `*.test.ts`, named as sentences
  (`it("rejects a second active run on the same thread")`).
- **Unit tests** for pure logic (run-engine transitions, SSE mapping, config parsing).
- **[Testcontainers](https://testcontainers.com)** integration tests for anything touching
  real infrastructure (`storage-postgres`, `redis`) — a real Postgres/Redis per suite.
- **Shared `SkeinStore` conformance suite** run against *every* storage driver, so memory and
  Postgres are held to the identical contract.

## 6. A checklist before you push

- [ ] Would a teammate (or you in six months) understand this without asking?
- [ ] Any function doing more than one thing? Split it.
- [ ] Any mutation of an input, or hidden side effect in a "pure" spot? Move it to the edge.
- [ ] Could an existing `@langchain/*` package have done this? ([reuse.md](./reuse.md))
- [ ] Did you delete the scaffolding/dead code you no longer need?
- [ ] Names, types, and tests read like plain English?
