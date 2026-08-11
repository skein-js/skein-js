# Human-in-the-loop

Pause a run for a person to approve, edit, or answer something — and resume it later, possibly hours
later, from a different client. An interrupted run holds no connection and no timer, only a
checkpoint, so your process can restart while it waits.

## Pause the graph

Call LangGraph's `interrupt()` from a node. Whatever you pass becomes the payload your UI renders:

```ts
import { interrupt } from "@langchain/langgraph";

function askForApproval(state: State) {
  const answer = interrupt({
    question: "Send this email?",
    draft: state.draft,
  });
  return { sent: answer === true };
}
```

The run settles, the thread's status becomes `interrupted`, and the interrupt surfaces in the stream.
Nothing is holding anything open.

## Resume it

```ts
await client.runs.create(threadId, "agent", {
  input: null, // not a new turn — pick up where the interrupt parked
  command: { resume: true },
});
```

`input: null` plus a `command` is the whole idiom. The run resumes from the checkpoint the interrupt
parked on rather than starting over, and the value you pass in `resume` is what `interrupt()` returns
inside the node.

Three commands are available:

| Command  | Does                                        | Use for                                    |
| -------- | ------------------------------------------- | ------------------------------------------ |
| `resume` | Returns a value from the `interrupt()` call | Approve / reject / supply an edited answer |
| `update` | Writes state before continuing              | Correcting something the graph got wrong   |
| `goto`   | Continues at a named node                   | Sending the turn down a different path     |

If you're building on `POST /threads/{id}/commands` directly, it infers the assistant from the
thread's last run, so you don't have to track it — and it **409s (`thread_not_interrupted`)** on a
thread that isn't paused, rather than quietly starting a new turn.

## In a React UI, this is free

[`useStream`](./react-sdk.md) renders the interrupt and resumes it for you — no extra endpoints, no
polling. The interrupt arrives on the stream, you render your approval card, and submitting a command
continues the same conversation.

## Find what's waiting

An approvals queue is a thread search:

```ts
const waiting = await client.threads.search({ status: "interrupted" });
```

The [console](./console.md) ships this view already — its Overview lists what's waiting for you, and
the Interrupts view approves, rejects, or resumes with any JSON, without you building a UI first.

## What you must get right

- **A checkpointer is required.** Without one there is no checkpoint to park on, and resume silently
  no-ops — the single most common way this fails. `skein dev` gives you one; in code, use
  `embedInMemoryGraphs`/`embedPostgresGraphs` or supply your own. See [embedding.md](./embedding.md).
- **Use durable storage for anything real.** With the in-memory driver an interrupted thread is gone
  on restart, which defeats the point of pausing for a human. [Postgres](./storage.md) keeps it.
- **The pause has no timeout.** A thread waits indefinitely. If your product needs "auto-reject after
  48 hours", that's a [cron](./crons.md) sweeping `status: "interrupted"` threads — skein won't do it
  for you.
- **Resuming starts a new run.** The interrupted run is terminal; the resume is a fresh run on the
  same thread. So a webhook fires per run, and the run id you resumed with is not the id you get back.
- **Not available on `POST /invoke/:graph_id`**, which has no thread to park on. See
  [serving-a-single-graph.md](./serving-a-single-graph.md).

## Interrupting from outside the graph

You can also pause without an `interrupt()` call, by naming nodes on run creation:

```ts
await client.runs.create(threadId, "agent", { input, interruptBefore: ["send_email"] });
```

`interruptBefore` / `interruptAfter` take a list of node names, or `"*"` for every node. This is a
debugging and stepping tool more than a product feature — `interrupt()` is what you want when the
pause is part of the design, because it carries a payload the UI can render.

## Working examples

- [`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent) — reached by
  a conditional edge, so only items that need a human park. Runs with no API key and no network;
  approve from the console.
- [`chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app) — an approval card in
  a real Next.js UI.

## See also

- [Threads](./threads.md) — the `interrupted` status, and editing state before you resume
- [Runs](./runs.md) — what a resume run is, and multitask strategies
- [Frontend SDKs & `useStream`](./react-sdk.md) — rendering and resuming in React
- [The console](./console.md) — approving without building a UI
- [Building a runner](./building-a-runner.md) — implementing interrupts for a non-LangGraph runtime
