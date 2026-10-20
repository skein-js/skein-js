# Deep Agent example

A LangChain [Deep Agent](https://docs.langchain.com/oss/javascript/deepagents/overview) served by skein
from an ordinary `langgraph.json`. The graph files import `deepagents`, not skein.

| Graph        | What it is                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `supervisor` | Plans, keeps notes, remembers per user, delegates to subagents, and asks before sending a report |
| `researcher` | The graph the supervisor runs as an **async** subagent, over HTTP, on this same server           |

It runs offline. With no `DEEP_AGENT_MODEL`, both graphs use a scripted model that reads a directive at
the start of your message ([`src/scripted-model.ts`](./src/scripted-model.ts)):

| Say                      | The supervisor                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `plan: gather; draft`    | writes a todo list                                                                 |
| `note: …` / `read-note`  | writes / reads `/notes.md`: thread state, gone with the thread                     |
| `remember: …` / `recall` | writes / reads `/memories/facts.md`: the store, shared by all of your threads      |
| `research: …`            | runs the `researcher` subagent in a tool call (stream it with `stream_subgraphs`)  |
| `send: to \| body`       | wants to call `send_report` and waits for approve / edit / reject                  |
| `background: …`          | starts the async subagent; then `check: <id>`, `update: <id> \| …`, `cancel: <id>` |

For a real model, set `DEEP_AGENT_MODEL` to a LangChain `provider:model` string, such as
`google-genai:gemini-2.5-flash` with `GOOGLE_API_KEY`.

```bash
pnpm dev                      # skein dev on :2024
pnpm nx test example-deep-agent # from the repository root; offline end-to-end suite
```

Callers identify themselves with an `x-user` header ([`src/auth.ts`](./src/auth.ts)). It is a demo
stand-in for real authentication, and it is what keeps one user's `/memories/` apart from another's
([`src/memory-namespace.ts`](./src/memory-namespace.ts)). The async subagent calls back into the server
at `SKEIN_URL` (default `http://127.0.0.1:2024`) as the originating caller. The supervisor is a graph
factory so every async client receives caller-specific headers. Production deployments should mint or
forward a caller-scoped credential instead of a shared service token. Task records arrive through
graph input and must not grant broader authority than the caller already has.

HTTP store routes are denied in this example; the graph's injected store still works through its
validated namespace callback. Replacing demo authentication with real authentication must retain both
thread ownership and store authorization.

The [Deep Agents recipe](../../docs/recipes/deep-agents.md) explains each choice. It also covers why
`LocalShellBackend` does not belong on a shared server.

When copying this example, also review the [dependency audit](../../docs/audits/dependency-advisories-2026-10-20.md).
Its local `braces` security patch is applied by this workspace's pnpm configuration and must be
carried into a standalone application's own dependency configuration until an upstream fix exists.
