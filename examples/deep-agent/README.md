# Research briefing assistant (Deep Agents)

> [!WARNING]
> **Experimental.** Serving LangChain Deep Agents on skein is experimental: it is tested end to end,
> but the integration may change in a minor release. See the
> [Deep Agents recipe](../../docs/recipes/deep-agents.md) for what is covered.

Ask it to brief you on a topic and it researches, writes and — with your sign-off — emails a one-page
briefing, remembering how you like them written. It is a LangChain
[Deep Agent](https://docs.langchain.com/oss/javascript/deepagents/overview) served by skein from an
ordinary `langgraph.json`; the graph files import `deepagents`, not skein.

```text
you › Remember that I prefer short briefings in bullet points.
assistant › Got it — I'll keep that in mind for every future briefing.

you › Brief me on heat pumps.
   assistant  · → read_file          checks your saved preferences
   assistant  · → write_todos        plans the briefing
   assistant  · → task               hands the research to its subagent
   researcher · writes its reply     (streamed separately with stream_subgraphs)
   assistant  · → write_file         saves the draft
assistant › Your briefing on heat pumps is ready in /briefings/heat-pumps.md.

you › Email the briefing to facilities@example.com
   (paused: send_briefing to facilities@example.com needs approval — approving)
assistant › Emailed "Briefing: heat pumps" to facilities@example.com.
```

## Run it

```bash
pnpm dev     # skein dev on :2024 — open the console at /console to watch the runs
pnpm demo    # in another terminal: the session above, through @langchain/langgraph-sdk
```

It runs offline: with no `DEEP_AGENT_MODEL`, both agents use a scripted model
([`src/scripted-model.ts`](./src/scripted-model.ts)) that follows these requests and writes sample
research notes. For a real model, set `DEEP_AGENT_MODEL` to a LangChain `provider:model` string, such
as `google-genai:gemini-2.5-flash` with `GOOGLE_API_KEY`; the graphs do not change.

| Ask                                     | What happens                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| "Brief me on heat pumps"                | Plans, delegates research to the `researcher` subagent, saves the draft      |
| "Email the briefing to sam@example.com" | Pauses for approve / edit / reject before `send_briefing` runs               |
| "Remember that I prefer bullet points"  | Saves to `/memories/preferences.md` — applies to all your conversations      |
| "What do you remember about me?"        | Reads your preferences back                                                  |
| "Start a deep dive on grid storage"     | Runs the `researcher` graph in the background, over HTTP on this same server |
| "How is the deep dive going?"           | Checks on it; "Tell the deep dive to …" and "Cancel the deep dive" steer it  |

## How it fits together

| File                                                               | What it shows                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [`briefing-assistant-graph.ts`](./src/briefing-assistant-graph.ts) | The `createDeepAgent` export: backends, approval, sync and background subagents |
| [`researcher-graph.ts`](./src/researcher-graph.ts)                 | The research agent, also served as its own graph for background deep dives      |
| [`memory-namespace.ts`](./src/memory-namespace.ts)                 | One store namespace per signed-in user, from the server-stamped identity        |
| [`auth.ts`](./src/auth.ts)                                         | Demo sign-in from an `x-user` header; threads are private to their owner        |
| [`briefing-assistant.test.ts`](./src/briefing-assistant.test.ts)   | The workflow end to end through the official SDK, offline                       |
| [`security.test.ts`](./src/security.test.ts)                       | What keeps one user's memory and deep dives away from another's                 |

**Files.** Drafts under `/briefings/` are thread state — they belong to the conversation that wrote
them. Preferences under `/memories/` live in skein's store under the signed-in user's namespace, so
they follow that person into every conversation and no one else.

**Sign-in.** `x-user` is a stand-in for real authentication; swap in a JWT or session check in
`auth.ts` and nothing else changes. The example also denies the HTTP `/store` routes, so memory is
reachable only through the graph's own namespace. Keep both thread ownership and store authorization
when you replace it.

**Deep dives** call back into the server at `SKEIN_URL` (default `http://127.0.0.1:2024`) with the
caller's own identity, which is why the assistant is a graph factory. In production, forward or mint a
caller-scoped credential rather than a shared service token.

When copying this example, also review the
[dependency audit](../../docs/audits/dependency-advisories-2026-10-20.md): its local `braces` security
patch is applied by this workspace's pnpm configuration and must be carried into your own until an
upstream fix exists.
