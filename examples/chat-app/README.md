# `chat-app` example

The **flagship** skein-js demo: a full-stack research + trip-planning assistant with a
ChatGPT/Gemini-style UI. A Gemini agent **thinks out loud**, **searches the web**, **pulls structured
data into rich cards**, **remembers what you tell it across conversations**, and **pauses for your
approval before it books anything** — served by `skein dev`, streamed into a Next.js +
[shadcn/ui](https://ui.shadcn.com) frontend via [`useStream`](../../docs/react-sdk.md).

| Graph id   | File                                               | Needs a key?        | What it is                                                                                            |
| ---------- | -------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------- |
| `research` | [`src/research-agent.ts`](./src/research-agent.ts) | ✅ `GOOGLE_API_KEY` | A Gemini ReAct agent: **thinking** + web search + memory + trip tools with human-in-the-loop booking. |

It's a plain LangGraph.js graph — skein serves it unchanged.

## What you'll learn

This is the end-to-end reference for **rich agent UX** — everything you need to communicate with an
agent, not just print its final string:

- **Streamed model thinking.** Gemini "thinking" is enabled (`thinkingConfig.includeThoughts`), so
  the agent streams its reasoning as `thinking` content blocks; the UI renders them in a collapsible
  panel, separate from the answer.
- **A web-search tool.** `web_search` uses [Tavily](https://tavily.com) when `TAVILY_API_KEY` is set
  and falls back to a deterministic placeholder otherwise — so the demo runs on the Gemini key alone.
- **Structured tool results rendered as cards.** The trip tools (`get_weather`, `search_flights`)
  return **structured JSON**, which the UI renders as rich **weather and flight cards** instead of raw
  text. The data is deterministic mock data, so the demo needs no extra keys or network.
- **Human-in-the-loop interrupt/resume.** `book_flight` calls LangGraph's `interrupt()`, so the run
  **pauses** and the UI shows an **approval card**; approving resumes the run with a `Command`
  (`thread.submit(undefined, { command: { resume } })`). This works out of the box because `skein dev`
  injects a checkpointer — the same interrupt/resume path LangGraph Platform provides.
- **Long-term memory across threads.** A `save_memory` tool writes durable facts, and relevant
  memories are **auto-injected** into the system prompt before each turn (a dynamic `prompt` on
  `createReactAgent`), so the agent remembers you **across threads** without depending on the model to
  call a recall tool. Both use skein's injected LangGraph
  [`BaseStore`](../../docs/storage.md#long-term-memory-in-the-graph-getstore) (`getStore()`). Run with
  a Postgres store to get **pgvector semantic recall** (see below).
- **`useStream` on the frontend.** The Next.js UI consumes the SSE stream with the LangChain React
  hook — tokens, thinking, tool results, and interrupts all arrive over one connection.
- **Custom auth.** A LangGraph-style `Auth` handler applied across the whole Agent Protocol surface.

> **Recall is your choice, not skein's.** skein (like LangGraph) only makes the store available via
> `getStore()`; _how_ you recall is application code. This example auto-injects (see
> [`buildPromptWithMemories`](./src/research-tools.ts)); equally valid: expose recall as a tool the
> model calls, use a library like `langmem`, or skip memory entirely.

## How to run

Get a Gemini Developer API key from <https://aistudio.google.com/apikey>.

**Backend** — in one terminal:

```bash
cp .env.example .env          # paste your GOOGLE_API_KEY (optionally TAVILY_API_KEY)
pnpm install
pnpm dev                      # → skein dev --port 2024, serving the `research` graph
```

Its [`langgraph.json`](./langgraph.json) enables **CORS for `http://localhost:3005`** (the frontend)
and declares a `store.index` so semantic recall lights up on the Postgres store.

**Frontend** — in a second terminal:

```bash
cp .env.local.example .env.local   # already points at :2024, graph `research`
pnpm dev:ui                        # → next dev on http://localhost:3005
```

The UI has a **conversation history sidebar** (like ChatGPT/Gemini): "New chat" starts a fresh
thread, and each past chat is listed by its first message — selecting one re-opens that thread and
loads its messages from the server. (The list is remembered per browser via localStorage; the
transcripts live on the skein-js server.)

Open <http://localhost:3005> and try, in order:

1. _"Plan a trip to Tokyo — check the weather and find flights from San Francisco."_ — watch the
   **Thinking** panel, then a **weather card** and **flight cards** render from the tools' structured
   JSON (not raw text).
2. _"Remember that I fly out of SFO and prefer window seats."_ — the agent calls **save_memory**.
3. _"Book the cheapest morning flight."_ — the agent calls **book_flight**, the run **pauses**, and an
   **approval card** appears. Click **Approve & book** → the run resumes and a booking confirmation
   card lands. (Reject to see the cancelled path.) This is skein's human-in-the-loop interrupt/resume.
4. Click **New chat**, then ask _"Where do I fly out of?"_ — it answers _"SFO."_ The memory was saved
   in the first thread and auto-injected into this new one from skein's injected store — no recall
   tool call needed.

### Long-term memory with a durable store (optional)

The default in-memory store keeps memories only for the life of the process and does substring
recall. For durable, **pgvector semantic** recall — exactly what production would use — point
`skein dev` at Postgres (no full Docker needed):

```bash
export POSTGRES_URI=postgres://…      # a Postgres with the `vector` extension available
pnpm exec skein dev --port 2024 --store postgres
```

`buildRuntime` resolves the `store.index.embed` from `langgraph.json`
(`google_genai:text-embedding-004`) and enables pgvector search. Memories now survive restarts and
recall ranks by semantic similarity.

### Authentication (optional)

[`src/auth.ts`](./src/auth.ts) is a LangGraph-style [`Auth`](https://langchain-ai.github.io/langgraphjs/)
handler, referenced from [`langgraph.json`](./langgraph.json)'s `auth` block. skein applies it to
every request across the whole Agent Protocol surface — the same custom-auth model as LangGraph
Platform.

Posture: _open in dev, enforced in prod._ With no `SKEIN_API_KEY` the server is open and threads
are not owner-scoped, so local dev needs no setup. Set one to require an `X-Api-Key` header and turn
on ownership scoping:

```bash
# backend
export SKEIN_API_KEY=some-secret
pnpm exec skein dev --port 2024

# frontend — send the key from the browser (useStream({ apiKey }))
echo 'NEXT_PUBLIC_SKEIN_API_KEY=some-secret' >> .env.local
```

Once enforced, requests without a valid key get `401`, and every caller's threads and runs are scoped
to them (`@auth.on("threads")` returns an `owner` filter) so one user can't read or mutate another's.
Note: enabling scoping hides threads created _before_ it — they carry no `owner` metadata.

### Tests

```bash
# 1. Graph-logic unit tests — hermetic, no key, no network.
pnpm exec vitest run

# 2. Model-backed e2e over the official @langchain/langgraph-sdk (waits, streams, and asserts a
#    thinking frame). Skips automatically unless GOOGLE_API_KEY is set.
GOOGLE_API_KEY=... pnpm exec vitest run

# 3. Browser e2e — Playwright drives the shadcn UI and asserts streaming + a Thinking block + a tool
#    card render. Boots the backend and UI for you; needs a key and a browser.
npx playwright install chromium
GOOGLE_API_KEY=... pnpm test:e2e
```

## What to look at

Backend (the graph and its tools):

- [`src/research-agent.ts`](./src/research-agent.ts) — the ReAct agent: thinking config, tool wiring,
  and the dynamic memory-injecting prompt.
- [`src/research-tools.ts`](./src/research-tools.ts) — `web_search`, `save_memory`, and
  `buildPromptWithMemories` (the `getStore()` recall pattern).
- [`src/trip-tools.ts`](./src/trip-tools.ts) — `get_weather` / `search_flights` (structured JSON
  results) and `book_flight` (the `interrupt()` human-in-the-loop gate).
- [`src/auth.ts`](./src/auth.ts) — the custom `Auth` handler.
- [`langgraph.json`](./langgraph.json) — CORS, the `store.index` for pgvector, and the `auth` block.

Frontend (how the rich UX is rendered):

- [`app/page.tsx`](./app/page.tsx) — `useStream` wiring, the thread/sidebar UI, and interrupt handling.
- [`components/thinking-block.tsx`](./components/thinking-block.tsx) — the collapsible thinking panel.
- [`components/tool-call-card.tsx`](./components/tool-call-card.tsx) — dispatches structured tool
  output to the right card component.
- [`components/tool-results/`](./components/tool-results) — the weather / flight / booking cards.
- [`components/approval-card.tsx`](./components/approval-card.tsx) — the human-in-the-loop approve/reject UI.
