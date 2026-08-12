# Your first agent

From an empty directory to a deployed agent server. No LangGraph experience assumed — the parts of
it you need are explained here, where you need them.

If you already have a LangGraph.js graph or a `langgraph.json`, you want
[getting-started.md](./getting-started.md) instead: there is nothing to scaffold, and adopting skein
is a one-line change.

**Prerequisites:** Node ≥ 20 and a package manager. That's all — nothing in this guide needs an API
key until you decide you want one, and nothing needs Docker until the last section.

## 1. Create the project

```bash
npm create skein-js@latest my-agent
```

`pnpm create skein-js my-agent` and `yarn create skein-js my-agent` do the same thing. Keep the
`@latest`: without it, npm's cache can hand you an old copy of the scaffolder.

It asks two questions — where to put the project, and which model provider you want. **Pick "None"
for now.** You can add a model in a minute, and starting without one means nothing can go wrong
before you have seen the thing work.

Then:

```bash
cd my-agent
npm run dev
```

You now have an agent server on `http://localhost:2024`.

## 2. Look at it before you read any code

Open `http://localhost:2024/console`.

That's the **skein console**, served by your own process — no account, no hosted service, no tunnel.
Create a thread, send "hello", and watch the run execute. You will get `echo: hello` back, because
the graph you just created echoes its input.

This is worth doing before anything else: everything below is about changing what happens between
your message and that reply, and it helps to have seen the loop close.

## 3. What you actually got

Eleven files. The three that matter:

**`src/echo-graph.ts`** — your agent. We'll come back to it.

**`langgraph.json`** — how skein finds your graphs:

```json
{
  "node_version": "24",
  "graphs": { "echo": "./src/echo-graph.ts:graph" },
  "env": ".env"
}
```

`"./src/echo-graph.ts:graph"` means _the export named `graph` in that file_. The key — `echo` — is
what clients ask for by name. This is the same file format the LangGraph CLI reads, which is why
skein is a drop-in for it.

**`package.json`** — four commands that are the whole lifecycle:

|                        |                                                              |
| ---------------------- | ------------------------------------------------------------ |
| `npm run dev`          | what you're running: hot reload, in-memory state, zero setup |
| `npm run dev:services` | Postgres + Redis in Docker, needed by `start`                |
| `npm run build`        | compile your graphs to plain JavaScript in `.skein/`         |
| `npm start`            | serve that build — this is what production runs              |

The rest: `.env` and `.env.example` (identical, entirely commented out — nothing in them is required
yet), `compose.dev.yaml` (the services for `start`), `tsconfig.json`, a test, and a README.

## 4. Understanding the graph

Here is the whole agent:

```ts
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

function echo(state: typeof MessagesAnnotation.State): { messages: BaseMessage[] } {
  const last = state.messages.at(-1);
  const text = typeof last?.content === "string" ? last.content : "";
  return { messages: [new AIMessage(`echo: ${text}`)] };
}

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("echo", echo)
  .addEdge("__start__", "echo")
  .addEdge("echo", "__end__")
  .compile();
```

Four ideas, and they are the only LangGraph concepts you need to get started:

**State** is the data flowing through your agent. `MessagesAnnotation` is a ready-made state that
holds a list of chat messages and knows to _append_ new ones rather than replace the list. Most
conversational agents want exactly this.

**A node** is a function. It receives the current state and returns only the part that changed — here,
one new message. It is a plain function: you can call it, test it, and step through it in a debugger.

**Edges** say what runs next. `__start__` and `__end__` are the built-in entry and exit points, so
this graph is "start → echo → done." Real agents branch here — that is where the "graph" part earns
its name.

**`.compile()`** turns the definition into something runnable. What it returns is what skein serves.

Try it: change `echo:` to `you said:` in `src/echo-graph.ts` and save. The server hot-reloads and
**keeps your existing threads** — send another message in the console and you will see the new reply
in the same conversation.

## 5. Give it a real model

Now swap the echo for an LLM. Install a provider:

```bash
npm install @langchain/anthropic
```

Create `src/agent-graph.ts`:

```ts
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const model = new ChatAnthropic({ model: "claude-sonnet-5", temperature: 0 });

export const graph = createReactAgent({ llm: model, tools: [] });
```

`createReactAgent` is LangGraph's prebuilt agent loop: call the model, and if it asks for a tool,
run the tool and call the model again. You did not have to build that loop.

Register it in `langgraph.json`:

```json
{
  "graphs": {
    "echo": "./src/echo-graph.ts:graph",
    "agent": "./src/agent-graph.ts:graph"
  }
}
```

Then give it a key — `.env` is already there, with every line commented out:

```bash
# in .env, set ANTHROPIC_API_KEY= — from https://console.anthropic.com/settings/keys
```

Restart, pick `agent` in the console, and you are talking to a real model. Tokens stream as they are
generated.

> Prefer to skip this assembly? `npm create skein-js@latest my-agent --provider anthropic` scaffolds
> all of it, plus a working tool, in one step.

## 6. Give it a tool

Talking is half of it. Tools are what let an agent actually do things:

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(
  async ({ city }: { city: string }) => {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
    ).then((response) => response.json());
    const place = geo.results?.[0];
    if (!place) return `I couldn't find ${city}.`;

    const forecast = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}` +
        `&longitude=${place.longitude}&current=temperature_2m`,
    ).then((response) => response.json());
    return `It's ${forecast.current.temperature_2m}°C in ${place.name}.`;
  },
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    schema: z.object({ city: z.string().describe("City name, e.g. 'Nairobi'") }),
  },
);
```

Pass it in — `createReactAgent({ llm: model, tools: [getWeather] })` — and ask "what's the weather in
Nairobi?". The console shows the model deciding to call the tool, the result coming back, and the
final answer. (Open-Meteo needs no API key of its own.)

The `description` and `schema` are how the model knows when to use it. Write them for a reader who
has no other context, because that is exactly the model's situation.

## 7. Talk to it from your own code

The server speaks the standard Agent Protocol, so the official SDK works — there is no skein client:

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });
const thread = await client.threads.create();

for await (const event of client.runs.stream(thread.thread_id, "agent", {
  input: { messages: [{ role: "user", content: "what's the weather in Nairobi?" }] },
})) {
  console.log(event.event, event.data);
}
```

For a UI, the `useStream` React hook talks to the same server with only a URL change — see
[react-sdk.md](./react-sdk.md). Vue, Svelte and Angular work too; so do
[Agent Chat UI](https://github.com/langchain-ai/agent-chat-ui) and LangGraph Studio.

## 8. Remember things between conversations

Threads persist a conversation. A **store** persists across conversations — what a user told you last
week. Any node can reach it:

```ts
import { getStore } from "@langchain/langgraph";

async function remember(state: typeof MessagesAnnotation.State) {
  const store = getStore();
  await store.put(["users", "alice"], "prefers", { units: "celsius" });
  const saved = await store.get(["users", "alice"], "prefers");
  // …use saved.value in your prompt
}
```

In `dev` this is in-memory. In production it is Postgres, with vector search for semantic recall —
and your node code does not change. See [storage.md](./storage.md) and [memory.md](./memory.md).

## 9. Ship it

`dev` is not the production path. Production is `build` + `start`:

```bash
npm run dev:services    # Postgres + Redis via Docker
# uncomment POSTGRES_URI and REDIS_URI in .env
npm run build           # graphs → plain JavaScript in .skein/build
npm start
```

`build` compiles your TypeScript graphs ahead of time; `start` serves that output with no TypeScript
toolchain in the loop. It is exactly what the production container runs.

`start` requires Postgres and Redis on purpose. That is what makes runs survive a restart, lets a
human approve an interrupt an hour later, and lets you run more than one instance.

For a container, `npx skein up` brings up the whole stack, and `npx skein build` produces an image.
Then pick a host: [Cloud Run](./deploy-cloud-run.md), [Fly](./deploy-fly.md),
[Railway](./deploy-railway.md), [Render](./deploy-render.md), [AWS](./deploy-aws.md),
[Kubernetes](./deploy-kubernetes.md), or [a plain VPS](./deploy-vps.md). Full guide:
[deploy.md](./deploy.md).

## Where to next

- [Recipes](./recipes/) — auth, human-in-the-loop, background runs, CORS
- [The console](./console.md) — what else that UI does: time travel, interrupt approvals, crons
- [Agent Protocol](./agent-protocol.md) — every endpoint your server exposes
- [Scaffolding reference](./scaffolding.md) — every flag, and the Nx generators
- [LangGraph.js docs](https://docs.langchain.com/oss/javascript/langgraph/overview) — for graphs more
  interesting than a straight line: branching, subgraphs, custom state
