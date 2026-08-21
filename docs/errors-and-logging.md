# Errors & logging

What happens when a graph throws — where the failure shows up, what a client sees, and what lands in
your logs. Errors and logging live in one doc because a failure goes to both, on deliberately
different terms: **the log gets everything; the wire gets what is safe to hand a caller.**

## When a graph throws

A node that throws does not crash the server. The run engine catches it, and five things happen:

| Surface               | What it gets                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| **The server log**    | An `error`-level line with the full stack and `cause` chain. Always — see [Logging](#logging). |
| **The SSE stream**    | A terminal `event: error` frame carrying a [`RunError`](#the-runerror-payload).                |
| **The run row**       | `status: "error"` plus `error` — the same `RunError`, durable.                                 |
| **The thread row**    | `status: "error"` plus `error` (the message). A _mirror of the latest turn_.                   |
| **`POST /runs/wait`** | `200` with `{ "__error__": { … } }` in place of the graph's values.                            |
| **The webhook**       | `error` as a plain message string, alongside the settled run.                                  |

The run row is the durable record. The thread's `status` and `error` are cleared as soon as a later
run on that thread succeeds — they describe the thread _now_, not its history. If you need to know
why a particular run failed, read the run.

```bash
curl localhost:2024/threads/$THREAD/runs/$RUN
```

```json
{
  "run_id": "63086ee4-…",
  "status": "error",
  "error": {
    "error": "Error",
    "name": "Error",
    "message": "model call failed",
    "cause": { "error": "Error", "name": "Error", "message": "MISSING_KEY is undefined" }
  }
}
```

### The `RunError` payload

One shape (`RunError`, from `@skein-js/core`) is used by the SSE frame, the persisted `Run.error`,
and the `__error__` wait body — so the stream and a later `GET` can never disagree.

| Field     |                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error`   | The error's constructor name. LangGraph Platform's name for this field.                                                                                           |
| `message` | The error's message. The one field every client renders.                                                                                                          |
| `name`    | Always identical to `error` — see [compatibility](#langgraph-platform-compatibility).                                                                             |
| `cause`   | The `Error.cause` chain, one `RunError` per link, up to five deep.                                                                                                |
| `errors`  | An `AggregateError`'s members (up to ten) — LangGraph throws one when several nodes fail in the same superstep, and its envelope message alone tells you nothing. |
| `stack`   | **Only when the server opts in.** See below.                                                                                                                      |

`toRunError(thrown, { includeStack })` builds one from anything thrown. It is cycle-safe, depth
capped, and never throws — it runs on the failure path, where a second failure would hide the first.

### `exposeErrorStacks`

A stack names server file paths, dependency versions, and sometimes argument values. So it goes to
your logs unconditionally, and to the **client** only when you ask:

```ts
const deps: ProtocolDeps = { /* … */ exposeErrorStacks: true };
```

- **`skein dev` turns it on**, unconditionally — not behind `--verbose`. Needing a flag to find out
  why your graph crashed is the problem this exists to remove.
- **`skein start`, and every embedded server, leave it off.** LangGraph Platform never puts a stack
  on the wire either, so with it off the frame is a strict superset of the platform's.

Turning it off never costs you information as an operator: the server log has the full stack either
way. It only affects what the _client_ can see.

## Logging

skein logs through a four-method interface — no framework, no transport, no color:

```ts
interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}
```

Every adapter takes a `logger` option, and it reaches **the run engine** — not just the transport. It
is the one knob that decides whether a crashed graph is visible at all.

### What each adapter does by default

|                     | Default              | Why                                                                |
| ------------------- | -------------------- | ------------------------------------------------------------------ |
| `@skein-js/nestjs`  | Nest's own `Logger`  | A facade over `app.useLogger()` / `NestFactory.create({ logger })` |
| `@skein-js/fastify` | `fastify.log` (pino) | The host's own instance, honoring its config                       |
| `@skein-js/express` | **nothing**          | Express owns no logger — pass `createConsoleLogger()`              |
| `@skein-js/nextjs`  | **nothing**          | Same                                                               |

The split is deliberate. Where the framework owns a logger the host has already configured, skein
_borrows_ that decision — including the decision to be silent (`NestFactory.create({ logger: false })`,
`Fastify({ logger: false })`). Where it doesn't, defaulting on would mean a library writing into
someone's stdout uninvited, so skein stays quiet until asked:

> **The two standalone servers are the exception, and differ from each other.** `createNestServer`
> owns its bootstrap and keeps Nest's banner off, which silences the global facade — so it defaults to
> its own `ConsoleLogger` and `app.useLogger()` does _not_ redirect it; pass `logger` instead.
> `createFastifyServer` leaves pino off exactly as Fastify does, so it stays silent until you enable
> it with `{ fastify: { logger: true } }` or pass a `logger`.

```ts
import { createConsoleLogger, createExpressServer } from "@skein-js/express";

createExpressServer({ config: "./langgraph.json", logger: createConsoleLogger() });
```

`createConsoleLogger({ level, prefix })` is plain uncolored output — `level: "warn"` suppresses the
per-run summaries while still reporting every failure. (The colored, code-framed failure block is
`skein dev`'s; it knows your source root and can safely read from it.)

### Precedence

| Situation                    | Result                                                |
| ---------------------------- | ----------------------------------------------------- |
| `deps.logger` is set         | that logger, always — the adapter never overwrites it |
| otherwise, `logger` a Logger | that logger                                           |
| otherwise, `logger: false`   | nothing — no default installed                        |
| otherwise                    | the adapter's default from the table above            |

An injected `deps.logger` outranking the adapter option is deliberate, and it is what makes the rest
safe: the adapter only ever _fills_ `deps.logger`, never replaces it. That in turn lets it hand the
engine your actual deps object rather than a copy — which is what keeps post-mount configuration
(`deps.exposeErrorStacks = true` after mounting) working, since the invoke surface re-reads its deps
on every request.

### Bridging to your own logger

Each bridge ships with its adapter, so meta lands in the shape that logger actually wants:

```ts
import { createNestLogger } from "@skein-js/nestjs";
// Point skein at a specific LoggerService rather than the globally configured one.
SkeinModule.forRoot({ config, logger: createNestLogger({ logger: myPinoNestLogger }) });

import { createFastifyLogger } from "@skein-js/fastify";
// pino is object-first, so a failed run's ids become queryable fields and `err` gets pino's
// error serializer — not a pre-flattened string.
app.register(skeinPlugin, {
  config,
  logger: createFastifyLogger(app.log.child({ svc: "graphs" })),
});
```

Anything else is four lines against the interface above.

### What is always logged

A **failed run** is always reported at `error` level, whatever `logRunActivity` says. The `meta` is a
`RunFailureReport` — plain data plus the original `Error`, so a console logger can render a stack and
a code frame while a JSON logger can serialize the fields. Recognize it with `isRunFailureReport`.

Also always logged: background-run lifecycle summaries (at `error` level, with a `run_error` field,
when the run failed), webhook delivery failures, rollback failures, and queue-shutdown problems.

That is the whole steady-state volume — failures, plus one line per background run. The noisy
per-run chatter is behind `logRunActivity` and stays off.

One cost worth knowing: naming the node that threw takes a checkpointer read, so the engine skips
building the report when nothing is listening. With a logger configured — which, under NestJS and
Fastify, is now the default — a **failed** run pays that read. Successful runs are unaffected.

### Sending failures somewhere else

The log is one of **three** surfaces a failure reaches. The third is a telemetry sink — LangSmith,
PostHog, OpenTelemetry, or your own — which receives a `run.finished` event carrying the `RunError`,
the node that threw, and the original `Error`:

```ts
const sink: TelemetrySink = {
  name: "sentry",
  onRunEvent: (event) => {
    if (event.type === "run.finished" && event.cause) Sentry.captureException(event.cause);
  },
};
```

A sink is **server-side, like the log** — so it always gets the full `Error`, stack and `cause` chain
included, **regardless of `exposeErrorStacks`**. That flag governs only what reaches a client. See
[observability.md](./observability.md).

### What `--verbose` adds

`skein dev --verbose` sets `ProtocolDeps.logRunActivity`, which adds per-run _chatter_: run
start/finish with duration and frame count, each tool call and tool result, and interrupt prompts.
It costs nothing when off — the engine skips the stream inspection entirely.

It does **not** gate failures. A graph that throws is logged either way.

### The failure block

The CLI — `skein dev` and `skein start` alike — renders a graph failure as a fenced block naming the
run, the assistant, the thread, the node that threw, and a code frame pointing at the line:

```
error: Graph run failed: model call failed

       ──────────────────────── GRAPH RUN FAILED ────────────────────────
       run       63086ee4-1729-4744-8c8e-2cbdd48aff80
       assistant boom
       thread    76258f06-a401-44c0-a6d7-7e189a3f8b36
       node      call_model

         3 | function callModel(): never {
         4 |   const apiKey = process.env["MISSING_KEY"];
       > 5 |   throw new Error("model call failed", {
           |         ^
         6 |     cause: new Error(`MISSING_KEY is ${String(apiKey)}`),

       Error: model call failed
           at RunnableCallable.callModel (src/boom-graph.ts:5:9)
       caused by: Error: MISSING_KEY is undefined
       ──────────────────────────────────────────────────────────────────
```

The rules and blank lines are plain text, not color — piped logs, CI output, and `NO_COLOR` all
disable color, and a crash needs to stand out precisely there.

Two parts are best-effort and are simply omitted when unavailable, never faked:

- **The `node` row.** LangGraph rethrows a node's error verbatim, so the error object never names the
  node. skein reads it from the post-failure state snapshot instead, where the runner records an
  `__error__` write against the failing task. A failure before the graph started yields nothing, and
  a failure inside a subgraph names the _parent_ node.
- **The code frame.** It needs the stack to point at readable source inside the project. Under
  `skein dev` it does — vite's module runner source-maps stacks back to your `.ts` files, and the
  frame is bounded to the workspace root vite serves from. Under `skein start` the bundled artifact
  usually ships without original sources, so the frame is normally absent and the stack still prints.

  The frame is deliberately conservative about where it reads from, because an error _message_ is
  frequently attacker-influenced — a raw model response, a fetched document, or simply
  ``throw new Error(`bad mode: ${input.mode}`)`` over a client-supplied input. Since `Error.stack`
  is `${name}: ${message}` followed by the frames, a newline in a message produces a line that parses
  exactly like a stack frame and sits ahead of every genuine one. skein parses frames only from the
  region after the header, and reads only files resolving inside the project root — so a crafted
  message cannot steer it into reading an unrelated file.

### The load-failure block

A graph can fail the other way too — never loading at all, because importing its module threw. That
is the failure a fresh project hits first, and almost always for one reason: the graph builds a model
client at module scope and the API key is not set.

`skein dev` and `skein start` import every declared graph once at startup, **after** the banner, and
report each failure as its own block:

```
error: graph "agent" failed to load

       ────────────────────── GRAPH FAILED TO LOAD ──────────────────────
       graph     agent
       source    src/agent-graph.ts:68

         66 | const apiKey = process.env.GOOGLE_API_KEY;
         67 | if (!apiKey) {
       > 68 |   throw new Error(
            |   ^

       GOOGLE_API_KEY is not set — the "agent" graph needs it. Uncomment it in
       .env (get a key at https://aistudio.google.com/apikey) and save; the dev
       server picks it up on reload. The "echo" graph needs no key.

       SkeinConfigError: Failed to import graph module ".../src/agent-graph.ts".
       caused by: Error: GOOGLE_API_KEY is not set — the "agent" graph needs it. …
       ──────────────────────────────────────────────────────────────────
```

The headline is the **root** of the `cause` chain, not the wrapper: `SkeinConfigError` says _where_
the failure happened, and only its cause says _what_ went wrong. The code frame follows the root's
stack for the same reason — the wrapper's stack is nothing but skein frames. The full chain still
prints underneath.

One graph that cannot load never takes the server down; the rest keep serving. Under `skein dev` the
project's `.env` is watched, so filling in the missing key and saving reloads the graphs — a key that
is _newly added_ takes effect, while changing one that is already set still needs a restart (the
ambient environment outranks the file, by design).

## Errors at the edges

Two typed errors, both carrying a `cause` that the CLI prints:

- **`SkeinHttpError`** (`@skein-js/core`) — carries the HTTP status a handler wants, plus optional
  `code` and `details`. Adapters map it to `{ status, message, code?, details? }`; anything else
  becomes an opaque `500` with the real error sent to the logger. See
  [building-an-adapter.md](./building-an-adapter.md).
- **`SkeinConfigError`** (`@skein-js/config`) — a bad `langgraph.json`, an unknown graph, or a graph
  module that failed to import. Its `cause` is the actual import failure and its `details` are the
  Zod issues, so read past the top-level message.

A graph that fails to _load_ during a **run** surfaces through the same failure path as one that
throws, with the config error's `cause` chain intact — unchanged.

On the surfaces that answer over HTTP directly — thread state and history, assistant introspection,
the single-graph invoke handler — it is mapped to a `SkeinHttpError` carrying `code:
"graph_load_failed"`, so it stops being an unhandled fault. How much of _why_ reaches the caller is
governed by [`exposeErrorStacks`](#exposeerrorstacks), the same switch that governs stacks:

|                                   | Body                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **`skein dev`** (on)              | `{"status":500,"message":"Graph \"agent\" failed to load: GOOGLE_API_KEY is not set …","code":"graph_load_failed"}` |
| **`skein start`**, embedded (off) | `{"status":500,"message":"Graph \"agent\" failed to load.","code":"graph_load_failed"}`                             |

The reason is withheld in production because a load failure's message is not skein's: `Cannot find
module '/srv/app/dist/tools.js'` and `connect ECONNREFUSED 10.0.3.14:5432` are both ordinary ones,
and they name server paths and internal hosts. The stack never travels either way.

**The operator loses nothing.** Adapters log every `5xx` — including this one, typed or not — with
the full `cause` chain, so the reason is always in your logs even when it is not on the wire.

`rootCause(thrown)` / `rootCauseMessage(thrown)` (`@skein-js/core`) are what collapse a chain to one
sentence, if you want the same in your own handler. Cycle-safe and depth-capped, like `toRunError` —
which you want instead when a client should see _every_ layer.

## LangGraph Platform compatibility

Verified against `@langchain/langgraph-api` and `@langchain/langgraph-sdk`:

- The platform's error frame is `{ error, message }`, and the SDK's `ErrorStreamEvent` declares
  exactly that. Its `StreamError` reads `data.name ?? data.error`. skein emits **both** `error` and
  `name` with the same value, so the SDK, the platform's own clients, and older skein clients (which
  saw only `name`) all agree. Extra keys are ignored by the SDK.
- `Run.error` is a skein extension — the SDK's `Run` records only _that_ a run failed. It is
  optional, so a client that ignores it is unaffected. This and the `"cancelled"` run status are the
  only two places skein deliberately steps outside the SDK's wire contract.
- `Thread.error` **is** an SDK field that the JS platform leaves empty; skein populates it (and keeps
  the older `metadata.error` alongside it for existing readers).
- `ThreadTask.error` is a JSON string, because `useStream` reads thread history by `JSON.parse`ing
  this field and rebuilding a `StreamError` from it.
- `POST /runs/wait` answers a failed run with `{ "__error__": … }`, the platform's key. skein does
  not reproduce the platform's double-encoding of that payload.
- The webhook's `error` is a plain message string, matching the platform exactly.
