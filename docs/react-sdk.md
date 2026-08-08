# React SDK / `useStream` compatibility

A core promise of skein-js: **your existing frontend code keeps working by changing only the
API URL.** That includes the React streaming hook, which is the most common way LangGraph
apps render agent output.

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

## Contents

- [The clients skein-js must satisfy](#the-clients-skein-js-must-satisfy)
- [`useStream` against skein-js](#usestream-against-skein-js)
- [Why it works over SSE](#why-it-works-over-sse)
- [Verification harness](#verification-harness)
- [References](#references)

## The clients skein-js must satisfy

| Client           | Package                          | How it talks to skein-js                                         |
| ---------------- | -------------------------------- | ---------------------------------------------------------------- |
| Vanilla JS SDK   | `@langchain/langgraph-sdk`       | `client.threads.*`, `client.runs.stream()`, `client.runs.wait()` |
| **React hook**   | `@langchain/langgraph-sdk/react` | **`useStream({ apiUrl, assistantId })`** over SSE                |
| Agent Chat UI    | (built on `useStream`)           | Same SSE path                                                    |
| LangGraph Studio | —                                | Agent Protocol HTTP                                              |

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

[`examples/react-usestream`](https://github.com/skein-js/skein-js/tree/main/examples/react-usestream) is a minimal Next.js app wired to
`useStream` and pointed at a placeholder skein-js URL. Once the server lands, it is the
front-end signal that the SSE wiring satisfies the React SDK — token-by-token streaming in
a real browser. See [roadmap.md](./roadmap.md#verification).

## References

- LangGraph JS SDK — <https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk>
- `useStream` API reference — <https://reference.langchain.com/javascript/langchain-langgraph-sdk/react/useStream>
- LangGraph streaming — <https://docs.langchain.com/oss/javascript/langgraph/streaming>
- Agent Chat UI — <https://github.com/langchain-ai/agent-chat-ui>
