# React SDK / `useStream` compatibility

A core promise of Skein: **your existing frontend code keeps working by changing only the
API URL.** That includes the React streaming hook, which is the most common way LangGraph
apps render agent output.

## The clients Skein must satisfy

| Client | Package | How it talks to Skein |
| --- | --- | --- |
| Vanilla JS SDK | `@langchain/langgraph-sdk` | `client.threads.*`, `client.runs.stream()`, `client.runs.wait()` |
| **React hook** | `@langchain/langgraph-sdk/react` | **`useStream({ apiUrl, assistantId })`** over SSE |
| Agent Chat UI | (built on `useStream`) | Same SSE path |
| LangGraph Studio | — | Agent Protocol HTTP |

## `useStream` against Skein

```tsx
"use client";
import { useStream } from "@langchain/langgraph-sdk/react";

export function Chat() {
  const thread = useStream({
    apiUrl: process.env.NEXT_PUBLIC_SKEIN_URL!, // e.g. http://localhost:2024
    assistantId: "agent",                        // a graph id from langgraph.json
  });

  return (
    <div>
      {thread.messages.map((m) => (
        <div key={m.id}>{typeof m.content === "string" ? m.content : ""}</div>
      ))}
      <button
        onClick={() =>
          thread.submit({ messages: [{ type: "human", content: "hello" }] })
        }
      >
        Send
      </button>
    </div>
  );
}
```

The only difference from a LangGraph Platform setup is that `apiUrl` points at a Skein
server. `useStream` opens an SSE connection to `/runs/stream` (or the thread stream) and
renders `messages` / `values` / `custom` events as they arrive — exactly the frames Skein
produces (see [streaming.md](./streaming.md)).

## Why it works over SSE

`useStream` is an SSE client. Because Skein serves the Agent Protocol streaming endpoints as
`text/event-stream` with the same event names and payloads LangGraph emits, the hook cannot
tell the difference. **No WebSocket is required**, so deferring WebSocket transport in v1
does not affect the React SDK.

## Verification harness

[`examples/react-usestream`](../examples/react-usestream) is a minimal Next.js app wired to
`useStream` and pointed at a placeholder Skein URL. Once the server lands, it is the
front-end signal that the SSE wiring satisfies the React SDK — token-by-token streaming in
a real browser. See [roadmap.md](./roadmap.md#verification).

## References

- LangGraph JS SDK — <https://www.npmjs.com/package/@langchain/langgraph-sdk>
- `useStream` docs — <https://docs.langchain.com/oss/javascript/langgraph/streaming>
- Agent Chat UI — <https://github.com/langchain-ai/agent-chat-ui>
