# Build an Angular UI with A2UI

Run the Angular playground to turn a public GitHub username or repository into an interactive
A2UI view. Skein streams the generated surfaces and saves them so you can review, revise, and
reopen the result.

## Run the example {#try-the-complete-journey}

Use Node 26 and the repository's pnpm version. In a fresh [Skein checkout](https://github.com/skein-js/skein-js),
run these commands from the repository root.

```sh
pnpm install
cd examples/a2ui
cp .env.example .env
```

Set these values in the example's backend `.env`. Choose a Gemini model that supports tool calling.

```dotenv
A2UI_MODEL=google:YOUR_MODEL_ID
GOOGLE_API_KEY=YOUR_API_KEY
```

Start the frontend and graph server with `pnpm dev:all`. Open [the playground](http://127.0.0.1:3007).
GitHub lookups use the public REST API and its anonymous quota.

## Try a prompt and revise the result {#use-the-chat-playground}

1. Send **Build a dashboard for skein-js/skein-js**. The repository view appears in chat and the
   JSON panel shows the surface messages.
2. Select **Approve UI** or **Reject** to record a decision and continue the conversation.
3. Submit **Show only stars and forks** through the generated feedback form. Review the revision,
   then use **Dismiss notes** to remove the notes surface without another model call.
4. Reload the thread URL to restore the saved surfaces and any pending review.

Try the profile for `@octocat` or the recently pushed repositories for `@torvalds` in a new chat.

![A model-generated GitHub dashboard rendered by Angular A2UI](/images/a2ui/trip-planner.png)

## Bring the pattern into your application

Start with Angular 21 and a [Skein-hosted LangGraph graph](../langgraph-essentials.md). Follow the
[example README](https://github.com/skein-js/skein-js/tree/main/examples/a2ui) to find the modules
to adapt.

### Give the model tools

The shared agent uses a model node to select GitHub lookups and a LangGraph `ToolNode` to run them.
A second model call receives the results, the renderer's catalog instructions, and the prior UI
for revisions.
[Shared GitHub agent](https://github.com/skein-js/skein-js/tree/main/examples/github-playground)

### Register and render components

For an existing Angular 21 app, install the renderer and core packages used here.

```sh
npm install @a2ui/angular@0.14.0 @a2ui/web_core@0.15.0 zod@4.6.7
```

Register the A2UI 1.0 Basic Catalog with `provideA2UI`. To use native Angular components with
`@a2ui/angular@0.14.0`, follow the example's component overrides and set
`useUniversalComponents: false`. The session observes the renderer's surface creation and
deletion events. The standalone surface view mounts one `<a2ui-v09-surface>` per matching ID.
Keep unchanged surfaces mounted when applying a new snapshot so a sibling update preserves
local form values.
[Angular configuration](https://github.com/skein-js/skein-js/blob/main/examples/a2ui/src/app/app.config.ts) ·
[Surface view](https://github.com/skein-js/skein-js/blob/main/examples/a2ui/src/app/ui-surfaces.ts) ·
[A2UI client integration guide](https://a2ui.org/guides/client-integration/#step-1-install-dependencies)

The demo supplies an escaped plain-text renderer through `provideMarkdownRenderer`. The published
`@a2ui/markdown-it@0.2.2` expects web core 0.14. The renderer and agent SDKs require web core 0.15.

### Compile model output on the server

Use `A2uiGenerator` with `DirectJsonFormatFactory` to build a processor for the renderer's
capabilities. Add the surface IDs and action rules to the processor's prompt. Feed model text
through `openStream().feed(text)`, then call `close()`. Validate each complete message and
check the final surface layout before saving.
[Server generation](https://github.com/skein-js/skein-js/blob/main/examples/a2ui/src/ui-generation.ts)

### Deliver A2UI over existing SSE

Use `config.writer` to send complete A2UI messages in custom events with a generation ID and
sequence number. Create a run with the LangGraph SDK, join its stream, and pass the messages from
root custom events to the A2UI processor. The SDK handles the Agent Protocol SSE envelopes.
[Graph](https://github.com/skein-js/skein-js/blob/main/examples/a2ui/src/ui-graph.ts) ·
[Skein stream modes](../streaming.md#streaming-json-ui-specifications)

### Send capabilities, form data and actions

Forward `a2uiRendererCapabilities` when starting generation. For bound forms, set
`sendDataModel: true` on the editable surface and send `a2uiRendererDataModel` with the action.
Validate the action, surface, source component, and submitted values against the saved UI before
dispatching it to a LangGraph `ToolNode`. `reviseUi` sends the feedback to generation and
`dismissNotes` deletes the notes surface. Keep history read-only and disable its data model
submission.
[Angular session service](https://github.com/skein-js/skein-js/blob/main/examples/a2ui/src/app/ui-session.ts) ·
[Graph tools](https://github.com/skein-js/skein-js/blob/main/examples/a2ui/src/ui-graph.ts)

### Checkpoint surfaces and review separately

Save one bootstrap `createSurface` message per active surface, together with the generation ID
and snapshot version. After generation checkpoints that state, use a separate `interrupt()`
node for review. Resume with the saved interrupt ID and verify the generation ID before recording
the decision. The SDK request hook guards retries and competing tabs.
[SDK request hook](https://github.com/skein-js/skein-js/blob/main/examples/a2ui/src/ui-client.ts) ·
[Human-in-the-loop](../human-in-the-loop.md)

### Restore and recover

Read `threads.getState` to restore saved surfaces and pending review. Reconnect to the same run
with `lastEventId` and skip duplicate messages. If updates are missing or invalid, show the last
saved UI and read the terminal checkpoint. **Pause updates** stops observation. **Stop run**
requests cancellation and restores the saved state. A failed prompt stays in the composer
for retry. When the response is saved, clear only the draft that was submitted.
[SDK session](https://github.com/skein-js/skein-js/blob/main/examples/a2ui/src/ui-session.ts)

## Authentication and hosting

The local server keeps threads in memory until it stops. Use [durable storage](../deploy.md) for
restarts. When hosting, replace the demo identity with [verified authentication](./authentication.md),
retain thread ownership checks, and route the frontend's `/api` requests to the Skein backend.
Keep model credentials on the backend.

## Tested versions and limits

The example uses A2UI 1.0 and pins Angular 21.2.25, `@a2ui/agent` 0.1.0, `@a2ui/web_core` 0.15.0,
`@a2ui/angular` 0.14.0, and the LangGraph SDK 1.12.7. It restores saved snapshot version 2.
If a saved chat uses an incompatible version, use **New chat**.
[Example manifest](https://github.com/skein-js/skein-js/blob/main/examples/a2ui/package.json)

### A2A interoperability {#a2a-interoperability-is-separate}

This playground delivers A2UI messages through Agent Protocol custom events. See
[Skein's A2A reference](../agent-protocol.md#mcp-and-a2a) for the supported A2A transport.

Try the same GitHub prompt with the [React json-render recipe](./json-render.md).
