# Frontend SDKs / `useStream` compatibility

Connect your frontend to a running skein-js server with LangChain's official SDKs for React, Vue,
Svelte, and Angular. LangChain maintains the frontend packages; Skein supplies the Agent Protocol
backend. Set the client's `apiUrl` to your Skein server and `assistantId` to your graph's Assistant ID.

Read [LangChain's frontend SDK guide](https://docs.langchain.com/oss/javascript/langchain/frontend/overview)
for framework patterns and UI capabilities. This page covers connecting those SDKs to Skein, with
setup examples and [tested client versions](./langgraph-compatibility.md).

React, Vue, and Svelte use `useStream`; Angular uses `injectStream`. Submit turns, read streamed
messages, show errors, and respond to human-approval requests through the returned stream handle.
You build the interface; the SDK supplies the conversation state and actions.

## Connect a React UI {#usestream-against-skein-js}

Install the dedicated React package in your frontend:

```bash
npm install @langchain/react @langchain/core
```

Start your skein-js server, then use its API URL and a registered Assistant ID. This example assumes
the scaffolded `echo` graph and sends a known input:

```tsx
"use client";
import { useStream } from "@langchain/react";

export function Chat() {
  const thread = useStream({
    apiUrl: "http://localhost:2024",
    assistantId: "echo", // replace with your graph's Assistant ID
  });

  return (
    <div>
      {thread.messages.map((message) => (
        <p key={message.id}>{typeof message.content === "string" ? message.content : ""}</p>
      ))}
      {thread.error != null && <p role="alert">{String(thread.error)}</p>}
      <button
        disabled={thread.isLoading}
        onClick={() => void thread.submit({ messages: [{ role: "user", content: "hello" }] })}
      >
        Send hello
      </button>
      {thread.isLoading && <button onClick={() => void thread.stop()}>Stop</button>}
    </div>
  );
}
```

Choose **Send hello** and expect `echo: hello` in the conversation. A browser on a different origin
needs the [server's CORS policy](./recipes/serving.md#cors-for-a-browser-client) to allow your frontend.
For custom authentication, follow the [authentication recipe](./recipes/authentication.md#browser-cookies-and-cors).

The [`nextjs-app`](https://github.com/skein-js/skein-js/tree/main/examples/nextjs-app) example serves
both UI and protocol from one origin. For a complete application with tools, reasoning output,
and approval cards, see [`chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app).

## Handle pauses and failures

When your graph calls `interrupt()`, render its request from `thread.interrupt` and respond with the
value your graph expects. For a graph expecting `{ approved: boolean }`, an approval button can call:

```tsx
<button onClick={() => void thread.respond({ approved: true })}>Approve</button>
```

Use the matching rejection value on another test thread and verify that the action is not performed.
See [human-in-the-loop](./human-in-the-loop.md) for the graph and SDK examples.

Show `thread.error` to the user and inspect the run before retrying an ambiguous request. Call
`thread.stop()` when the user wants to cancel. Unmounting the UI or reopening a conversation does
not cancel or start a run by itself. Test restoration and multiple turns with your application's
thread-selection controls.

## Choose a client {#the-clients-skein-js-must-satisfy}

| Your application                     | Client                                                         |
| ------------------------------------ | -------------------------------------------------------------- |
| Node, a service, or a test           | `Client` from `@langchain/langgraph-sdk`                       |
| React                                | `useStream` from `@langchain/react`                            |
| An existing legacy React integration | `@langchain/langgraph-sdk/react` remains supported             |
| A ready-made chat frontend           | [Agent Chat UI](https://github.com/langchain-ai/agent-chat-ui) |
| Interactive graph development        | The [console](./console.md) or LangGraph Studio                |

For a JavaScript SDK smoke test with assertions and cleanup, see [Testing your project](./testing-your-project.md#check-the-running-server).

<span id="not-just-react-—-vue-svelte-and-angular"></span>

## Vue, Svelte, and Angular {#not-just-react-vue-svelte-and-angular}

Use the dedicated framework packages, not SDK subpaths such as `@langchain/langgraph-sdk/vue`:

| Framework | Package              | Entry points                                    | Tested peer range |
| --------- | -------------------- | ----------------------------------------------- | ----------------- |
| React     | `@langchain/react`   | `useStream`, `StreamProvider`                   | React 18–19       |
| Vue       | `@langchain/vue`     | `useStream`, `provideStream`, `LangChainPlugin` | Vue 3             |
| Svelte    | `@langchain/svelte`  | `useStream`, `provideStream`, `getStream`       | Svelte 5          |
| Angular   | `@langchain/angular` | `injectStream`                                  | Angular 18–21     |

Use each package's framework-specific setup. The [compatibility reference](./langgraph-compatibility.md)
lists the versions exercised with skein-js and known media limitations. There are no standalone
skein-js Vue, Svelte, or Angular example applications yet.

## Version and streaming reference {#dedicated-framework-packages}

The React examples use `@langchain/react` 1.2.7 and SDK 1.12.7. React, Angular, Vue, and Svelte 1.2.6
are also verified combinations. Treat these as tested versions, rather than a guarantee about every
future client release.

Svelte 1.2.6's root `useImages` selector returns an empty projection; use the scoped selector for the
subgraph namespace containing media. Vue 1.2.6 proxies media assets, so unwrap an asset before reading
its `blob`:

```ts
import { toRaw } from "vue";

const blob = await toRaw(images.value[0]).blob;
```

<span id="why-it-works-over-sse"></span>

Dedicated framework bindings use thread event subscriptions and commands. The legacy React hook
uses run-based streaming. Both use HTTP/SSE; no WebSocket configuration is required. See
[streaming](./streaming.md#thread-event-subscriptions) if you implement a custom client.

## Working example {#verification-harness}

[`react-usestream`](https://github.com/skein-js/skein-js/tree/main/examples/react-usestream) is a
minimal Next.js application. Start its graph server and UI using its README, send two turns, reopen
the conversation, and check that state is restored without another execution. Repeat with your own
graph before building a larger interface.

## Catalog-driven UI with json-render

The [json-render recipe](./recipes/json-render.md) and
[public React/Vite example](https://github.com/skein-js/skein-js/tree/main/examples/json-render)
show progressive component rendering, saved specifications, form/button inputs and interrupt/resume.
Use the official SDK run stream plus the upstream SpecStream compiler: json-render’s `useUIStream`
hook expects raw generation text, so a Skein SSE URL is not a direct endpoint replacement.

## References

- [React `useStream` reference](https://reference.langchain.com/javascript/langchain-react/useStream)
- [LangGraph JavaScript SDK](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk)
- [Vue bindings](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-vue)
- [Svelte bindings](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-svelte)
- [Angular bindings](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-angular)
