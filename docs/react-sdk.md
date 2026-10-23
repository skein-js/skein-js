# Frontend SDKs / `useStream` compatibility

Skein supports the run-based JavaScript SDK and the legacy React hook from
`@langchain/langgraph-sdk/react`. The newer `@langchain/react`, `@langchain/vue`,
`@langchain/svelte`, and `@langchain/angular` packages use a separate thread event protocol.
Versions 1.2.6 pass the dedicated browser matrix with the media workarounds described below; each
package is tested independently. See the [compatibility matrix](./langgraph-compatibility.md).

**What this gives you:** point
[`useStream`](https://reference.langchain.com/javascript/langchain-langgraph-sdk/react/useStream) at a
skein-js server and you get the whole rich chat UX for free — live token streaming, model
**thinking**, structured **tool-result cards**, and **human-in-the-loop** interrupt/resume — with no
custom SDK and no bespoke wire format. You send a turn with `thread.submit(...)`, read live state off
`thread.messages`, and when a graph node pauses with `interrupt()` you render an approval card off
`thread.interrupt` and resume with a `command`. The flagship [`chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app)
example builds all of this; [`react-usestream`](https://github.com/skein-js/skein-js/tree/main/examples/react-usestream) is the minimal
copy-paste starting point.

```tsx
// send a turn — thread.messages updates live as tokens stream in
thread.submit({ messages: [{ type: "human", content: input }] });

// a pending interrupt (e.g. "approve this booking?") surfaces here; resume with a command
if (thread.interrupt) {
  thread.submit(undefined, { command: { resume: { approved: true } } });
}
```

Long-term memory is the one piece that lives on the server, not in the hook: a graph node calls
`getStore()` and skein-js persists it (see [storage.md](./storage.md)). The frontend just keeps
streaming.

## The clients skein-js must satisfy

| Client                 | Package                                 | How it talks to skein-js                                                       |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| Vanilla JS SDK         | `@langchain/langgraph-sdk`              | `client.threads.*`, `client.runs.stream()`, `client.runs.wait()`               |
| **React hook**         | `@langchain/langgraph-sdk/react`        | **`useStream({ apiUrl, assistantId })`** over SSE                              |
| New framework bindings | `@langchain/{react,vue,svelte,angular}` | Thread event subscriptions and command envelopes; see the compatibility matrix |
| Agent Chat UI          | (built on `useStream`)                  | Same SSE path                                                                  |
| LangGraph Studio       | —                                       | Agent Protocol HTTP                                                            |

## Not just React — Vue, Svelte and Angular

LangChain publishes first-party bindings for four frameworks. Their current releases subscribe to
`POST /threads/{thread_id}/stream/events` and send protocol command envelopes to `/commands`.
This differs from the run-based endpoints used by the legacy React hook. A subscription must never
start a run, including when the client reconnects.

| Framework | Package                                                                                        | Entry points                                    | Peer range    |
| --------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------- |
| React     | [`@langchain/react`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-react)     | `useStream`, `StreamProvider`                   | React 18 · 19 |
| Vue       | [`@langchain/vue`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-vue)         | `useStream`, `provideStream`, `LangChainPlugin` | Vue 3         |
| Svelte    | [`@langchain/svelte`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-svelte)   | `useStream`, `provideStream`, `getStream`       | Svelte 5      |
| Angular   | [`@langchain/angular`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-angular) | `injectStream`, the `inject*` family            | Angular 18–21 |

Each follows its own idiom — a React hook, a Vue composable, Svelte context, Angular DI — over a
shared streaming core. The examples below use the legacy React API; consult the newer bindings'
documentation for their current API shapes.

**Mind the package names.** These are `@langchain/<framework>` packages, _not_ subpaths of the SDK —
`@langchain/langgraph-sdk/vue` does not resolve, and the SDK's own README links to them by monorepo
path, which is easy to misread as a subpath. `@langchain/langgraph-sdk/react` still exists and is what
the example below uses; the dedicated packages are the newer home and the only place the non-React
bindings live.

skein-js ships no standalone Vue, Svelte or Angular example. The dedicated compatibility CI job
exercises all four framework packages in Chromium, separately from the runtime matrix and legacy
`useStream` coverage. The [compatibility matrix](./langgraph-compatibility.md) records tested versions
and features.

## `useStream` against skein-js

```tsx
"use client";
import { useStream } from "@langchain/langgraph-sdk/react";

export function Chat() {
  const thread = useStream({
    apiUrl: process.env.NEXT_PUBLIC_SKEIN_URL!, // e.g. http://localhost:2024
    assistantId: "agent", // a graph id from langgraph.json
  });

  return (
    <div>
      {thread.messages.map((m) => (
        <div key={m.id}>{typeof m.content === "string" ? m.content : ""}</div>
      ))}
      <button onClick={() => thread.submit({ messages: [{ type: "human", content: "hello" }] })}>
        Send
      </button>
    </div>
  );
}
```

The only difference from a LangGraph Platform setup is that `apiUrl` points at a skein-js
server. `useStream` opens an SSE connection to `/runs/stream` (or the thread stream) and
renders `messages` / `values` / `custom` events as they arrive — exactly the frames skein-js
produces (see [streaming.md](./streaming.md)).

**Closing the tab cancels the run.** `useStream` sends `on_disconnect: "cancel"` on every submit unless
the stream is resumable, in which case it sends `"continue"`. skein honours that, so navigating away or
closing the tab settles the in-flight run as `cancelled` rather than letting it finish in the
background — LangGraph's behaviour, and usually the one you want, since nobody is left to read the
result. Pass `onDisconnect: "continue"` to `submit()` to keep the run going, or set
`reconnectOnMount` / a resumable stream so the client can rejoin it instead.

## Why it works over SSE

`useStream` is an SSE client. Because skein-js serves the Agent Protocol streaming endpoints as
`text/event-stream` with the same event names and payloads LangGraph emits, the hook cannot
tell the difference. **No WebSocket is required**, so deferring WebSocket transport in v1
does not affect the React SDK.

## Verification harness

[`examples/react-usestream`](https://github.com/skein-js/skein-js/tree/main/examples/react-usestream)
is a minimal Next.js app using the legacy hook. The dedicated browser target exercises current
framework packages over real HTTP, and the packed consumer checks both current and legacy clients
outside the workspace. See [testing.md](./testing.md#compatibility-regression-gates).

## References

- LangGraph JS SDK — <https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk>
- `useStream` API reference — <https://reference.langchain.com/javascript/langchain-langgraph-sdk/react/useStream>
- LangGraph streaming — <https://docs.langchain.com/oss/javascript/langgraph/streaming>
- Agent Chat UI — <https://github.com/langchain-ai/agent-chat-ui>
- React bindings — <https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-react>
- Vue bindings — <https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-vue>
- Svelte bindings — <https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-svelte>
- Angular bindings — <https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-angular>

## Dedicated framework packages

The dedicated `@langchain/react`, `@langchain/angular`, `@langchain/vue`, and `@langchain/svelte`
packages use the thread event protocol. Versions **1.2.6** are exercised in Chromium against Skein
with their native HTTP transport, including multiple turns, restoration, interrupts, subgraphs,
custom transformer channels, scoped media, forced reconnect and cancellation. Reopening a
subscription never starts another graph execution. See the [compatibility matrix](./langgraph-compatibility.md)
for the exact server, SDK and backend evidence.

Svelte 1.2.6 has an upstream limitation: its root `useImages` selector returns an empty projection.
Scoped media selectors are covered; target the subgraph namespace containing the media. This is a
client selector limitation, even when the server sends valid root media events. React, Angular and
Vue root media selectors also pass the browser checks.

Vue 1.2.6 wraps media asset instances in reactive proxies. Reading an asset's `blob` directly can
throw a private-field error; unwrap it with Vue's public `toRaw` first. The browser gate verifies the
actual MIME type and bytes with this workaround:

```ts
import { toRaw } from "vue";

const blob = await toRaw(images.value[0]).blob;
```
