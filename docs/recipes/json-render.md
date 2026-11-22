# Build a streaming UI with json-render

Run the React playground to turn a public GitHub username or repository into an interactive view.
The agent looks up GitHub data, the model streams a component specification, and Skein saves each
validated response so you can review and reopen it.

## Run the example {#try-the-complete-journey}

Use Node 26 and the repository's pnpm version. In a fresh [Skein checkout](https://github.com/skein-js/skein-js),
run these commands from the repository root.

```sh
pnpm install
cd examples/json-render
cp .env.example .env
```

Set these values in the example's backend `.env`. Choose a Gemini model that supports tool calling.

```dotenv
JSON_RENDER_MODEL=google:YOUR_MODEL_ID
GOOGLE_API_KEY=YOUR_API_KEY
```

Start the frontend and graph server with `pnpm dev:all`. Open [the playground](http://127.0.0.1:3006).
If `GOOGLE_API_KEY` is missing or blank, Skein reports an error when it loads the graph.
GitHub lookups use the public REST API and its anonymous quota.

## Try a prompt and revise the result {#use-the-chat-playground}

1. Send **Build a dashboard for skein-js/skein-js**. The repository view appears in chat and the
   JSON panel shows its specification.
2. Select **Approve UI** or **Reject** to record a decision and continue the conversation.
3. Ask **Show only stars and forks** in chat or submit it through the generated feedback form.
4. Reload the thread URL to restore the saved views and any pending review. Earlier views remain
   readable and the current view accepts revisions after review.

Try the profile for `@octocat` or the recently pushed repositories for `@torvalds` in a new chat.

![A model-generated GitHub dashboard rendered by json-render](/images/json-render/plan-builder.png)

## Bring the pattern into your application

Start with React and a [Skein-hosted LangGraph graph](../langgraph-essentials.md). Follow the
[example README](https://github.com/skein-js/skein-js/tree/main/examples/json-render) to find
the modules to adapt.

### Give the model tools

The shared agent uses a model node to select GitHub lookups and a LangGraph `ToolNode` to run them.
A second model call receives the results and streams the UI. Use the previous saved specification
as revision context and compile a fresh specification for each response.
[Shared GitHub agent](https://github.com/skein-js/skein-js/tree/main/examples/github-playground)

### Define components and actions

Use `defineCatalog` with Zod to list the components and props your model can generate. Pair the
catalog with React components using `createRenderer` at module scope. Pass the active view's
action handler when mounting the renderer so earlier views keep their component identity.
The catalog binds both revision controls to `reviseUi`. Before saving a new spec, require a
visible root card and visible, bound revision controls.
[Catalog](https://github.com/skein-js/skein-js/blob/main/examples/json-render/src/catalog.ts) ·
[React renderer](https://github.com/skein-js/skein-js/blob/main/examples/json-render/src/app/generated-ui.tsx)

### Stream graph output through the compiler

Use `catalog.prompt({ customRules })` to teach the model your catalog and the SpecStream format.
Include a complete example that places component fields in `props` and defines every referenced
child. Each line is one JSON patch, so the compiler can apply it as it arrives.
[Model prompt](https://github.com/skein-js/skein-js/blob/main/examples/json-render/src/generation.ts) ·
[json-render streaming guide](https://json-render.dev/docs/streaming)

Emit start, chunk, and complete events with a generation ID and sequence number using
LangGraph's `config.writer`. Use the
LangGraph SDK to create a run and join its stream. Feed the text from the run's root custom events
into one `createSpecStreamCompiler()` per generation. Render each valid `push(text).result`
and call `getResult()` at completion to consume the final buffered line. Keep the last renderable
preview while a patch is incomplete.
[Graph](https://github.com/skein-js/skein-js/blob/main/examples/json-render/src/ui-graph.ts) ·
[Stream reader](https://github.com/skein-js/skein-js/blob/main/examples/json-render/src/ui-events.ts) ·
[Skein stream modes](../streaming.md#streaming-json-ui-specifications)

### Save and restore the UI

Checkpoint the validated spec with its generation ID and prompt. Read the thread with
`threads.getState` to reopen it or confirm a completed run. The checkpoint is authoritative,
including when the final stream frames are missing.
[SDK session](https://github.com/skein-js/skein-js/blob/main/examples/json-render/src/ui-session.ts)

### Route actions and approvals

Send `reviseUi` with the current generation ID and the resolved feedback prompt. At the graph
entry point, send ordinary prompts to generation and revision calls to a LangGraph `ToolNode`.
The tool checks that the revision targets the current reviewed UI, then passes its prompt to the
same model node.
[Graph and revision tool](https://github.com/skein-js/skein-js/blob/main/examples/json-render/src/ui-graph.ts)

Call `interrupt()` in a separate node after generation saves the UI. Resume with the saved
interrupt ID and validate the generation ID before recording the decision. The SDK request hook
makes retries idempotent and guards against competing tabs starting a run while review is pending.
[SDK request hook](https://github.com/skein-js/skein-js/blob/main/examples/json-render/src/ui-client.ts) ·
[Human-in-the-loop](../human-in-the-loop.md)

### Handle disconnects, cancellation and errors

Reconnect to the same run with `lastEventId` and skip duplicate sequence numbers before compiling.
If a patch fails to apply or the finished spec fails validation, LangGraph retries generation
once. The retry emits a new start event in the same run. Reset the compiler on that event so
the retry builds its own spec.
On a gap or error, show the last saved UI and reconcile with the terminal checkpoint. **Pause
updates** stops observation. **Stop run** requests cancellation and restores the saved state.
Clear the submitted draft after its response is saved, as long as the user is still editing
the same draft. A failed prompt stays in the composer for retry.

## Authentication and hosting

The local server keeps threads in memory until it stops. Use [durable storage](../deploy.md) for
restarts. When hosting, replace the demo identity with [verified authentication](./authentication.md),
retain thread ownership checks, and route the frontend's `/api` requests to the Skein backend.
Keep model credentials on the backend.

## Tested versions and limits

The example pins json-render 0.21.4, React 19.2.6, Zod 4.6.7, and the LangGraph SDK 1.12.7.
The SDK reads Agent Protocol SSE and passes selected text to SpecStream. Use the SDK bridge when
connecting this renderer to Skein. [Example manifest](https://github.com/skein-js/skein-js/blob/main/examples/json-render/package.json)

Try the same GitHub prompt with the [Angular A2UI recipe](./a2ui.md).
