# triage-agent — the workload the console was built to show

A cron sweeps a queue of issues, dispatches a **background run per issue on its own thread**, and each
run gathers context, classifies, checks its own work, and then either records the decision or **stops
and waits for a human**.

Get a [free Gemini API key](../../docs/recipes/index.md#free-api-keys-for-testing) and set
`GOOGLE_API_KEY` in `.env`. Gemini classifies the bundled sample issues and answers questions about
recorded decisions. A sample sweep uses no GitHub credentials.

```bash
cp .env.example .env
pnpm dev     # console at http://127.0.0.1:2024/console/
pnpm seed    # register the schedule and sweep once, from another terminal
```

## Why this example exists

The example shows how to operate a queue of model-backed runs:

| What you see                             | What it is                                                           |
| ---------------------------------------- | -------------------------------------------------------------------- |
| A schedule firing on its own             | [Crons](../../docs/crons.md) + the scheduler                         |
| Issues appearing as separate threads     | Background runs, one per item                                        |
| Re-sweeps that create nothing            | `Idempotency-Key` — **LangGraph Platform has no equivalent**         |
| Items waiting for you                    | `interrupt()` / `Command({ resume })`, reached by a conditional edge |
| The agent following your conventions     | `getStore()` long-term memory, read back into the prompt             |
| Restarting mid-run and finding it intact | Checkpointed, durable runs                                           |
| Trying a triage decision a second way    | Time travel — fork a checkpoint and re-run                           |

Nothing is ever posted to GitHub. The "action" is a store write.

## The three graphs

```text
sweep      START → fetch → filter → route ─┬→ dispatch → report → END
                                           └→ report ───────────→ END

triage     START → prepare → gather → classify → critique → route ─┬→ approve → record → END
                                                                   └→ record ───────────→ END

assistant  START → answer → END          (chat: ask what has been triaged)
```

`sweep` is the cron target: it fetches, drops what the store says is already decided, and dispatches
one idempotent background run per new item. `triage` is that per-item run. `assistant` is a **chat**
graph — it has a `messages` channel, so the console's playground offers a chat box for it and a JSON
editor for the other two.

The `triage` branch is the point. Spam and low-severity chatter record themselves; **bugs never do**, whatever
severity they were given, because wrongly ignoring one costs far more than one extra approval. The
reason for each decision is written into state as `routedBecause`, so the console shows _why_ a thread
is waiting — or why it never did.

## The demo script

Each step shows something the previous one could not.

1. **Playground** — the console opens here. Pick `assistant` and ask "what have you triaged?" — it is
   the chat graph. Pick `triage` and the Chat tab greys out, because that graph has no `messages`
   channel; the JSON editor is pre-filled with its actual input shape, and the diagram shows the
   branch it will take.
2. **Overview** — counts move as the sweep dispatches.
3. **Threads** — one per issue. Items that need a decision are `interrupted`.
4. **Open an interrupted one** → the **Waiting for you** panel shows the verdict, the Gemini model, and the draft reply.
   Click **Approve** to resume the run from its checkpoint.
5. **Store** → browse `triage/decisions`. That is what "approve" actually did. Now add a convention:

   ```bash
   curl -X PUT http://127.0.0.1:2024/store/items -H 'content-type: application/json' \
     -d '{"namespace":["triage","conventions"],"key":"cli","value":{"text":"CLI issues are always p2"}}'
   ```

   Triage another item and the agent reads it back in `gather`.

6. **Restart mid-run.** Ctrl-C and restart `skein dev` while a run is going. The thread is still there,
   at the step it reached.
7. **Sweep again** (`pnpm seed`). Watch the run count _not_ climb — the idempotency key replays the
   original responses instead of re-triaging. This is the step most people find surprising.
8. **Time travel.** On a finished thread, open the checkpoint before `route`, change `verdict.severity`
   to `high`, and **Fork and run** — it now takes the approval branch. The original stays as it was.
9. **Crons** — `pnpm seed` registers four schedules, between them covering every knob the resource
   has: a frequent sweep, an hourly deep pass with an `end_time`, a daily digest on the `assistant`
   graph in a real IANA timezone, and one that starts **paused**. Resume the paused one and watch
   `next_run_date` appear; pause a live one and watch it go.
10. **Store** → `triage/sweeps` is a history of what the schedule has actually been doing, which is
    otherwise invisible between occurrences.

## Going further

Triage open issues from a public GitHub repository:

```bash
export TRIAGE_SOURCE=github
export TRIAGE_REPO=owner/name       # default: skein-js/skein-js
```

Production shape — Postgres, Redis, the console behind `http.console`:

```bash
pnpm --filter @skein-js/example-triage-agent exec skein up
```

`skein up` builds the image and brings up app + Postgres + Redis. The console is served because
`langgraph.json` sets `http.console: true`; without it a deployed server serves no console at all.

## Configuration

| Variable          | Default                 | What it does                                                                                                                                                                                           |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRIAGE_SOURCE`   | `fixture`               | Bundled sample issues (`fixture`) or live GitHub issues (`github`).                                                                                                                                    |
| `GOOGLE_API_KEY`  | —                       | Required Gemini API key.                                                                                                                                                                               |
| `GOOGLE_MODEL`    | `gemini-3.5-flash-lite` | Gemini model for triage and chat.                                                                                                                                                                      |
| `TRIAGE_TIMEZONE` | `Africa/Nairobi`        | IANA timezone for the daily digest schedule.                                                                                                                                                           |
| `TRIAGE_REPO`     | `skein-js/skein-js`     | Repo to sweep when `TRIAGE_SOURCE=github`.                                                                                                                                                             |
| `TRIAGE_SCHEDULE` | `*/5 * * * *`           | Cron expression. Five fields — [sub-minute is a non-goal](../../docs/roadmap.md).                                                                                                                      |
| `GITHUB_TOKEN`    | —                       | Optional; raises GitHub's anonymous rate limit.                                                                                                                                                        |
| `TRIAGE_WEBHOOK`  | —                       | Optional; POSTed each settled run.                                                                                                                                                                     |
| `SKEIN_API_URL`   | `http://127.0.0.1:2024` | Where the sweep dispatches runs — **this server**. Set it if you run on another port; the sweep refuses to dispatch to a server that has no `triage` graph rather than quietly filling someone else's. |

## How it is put together

- [`src/triage-sources.ts`](./src/triage-sources.ts) — the item schema (Zod, validated at the
  boundary), the verdict schema, sources, and deduplication.
- [`src/classifier.ts`](./src/classifier.ts) — asks Gemini for a structured verdict.
- [`src/triage-graph.ts`](./src/triage-graph.ts) — prepare → gather → classify → critique → route →
  (approve) → record.
- [`src/sweep-graph.ts`](./src/sweep-graph.ts) — the cron target. One idempotent background run per
  item; the expensive work happens in those runs, not here.
- [`src/assistant-graph.ts`](./src/assistant-graph.ts) — asks Gemini to answer from recorded decisions.
- [`scripts/seed-cron.ts`](./scripts/seed-cron.ts) — registers the four schedules and kicks one sweep
  off.

The [unit tests](./src/triage-rules.test.ts) supply a model response and cover approval routing
and verdict checks.

The console is [`@skein-js/console`](../../packages/console) — see [docs/console.md](../../docs/console.md).
