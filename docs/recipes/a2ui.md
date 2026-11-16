# Build an Angular UI with A2UI

Use [A2UI](https://a2ui.org/) when an agent should compose interactive interfaces from components
registered by your application. Skein hosts the LangGraph graph and delivers its custom events;
upstream A2UI libraries compile, validate and render the UI.

This recipe follows the public [Angular UI playground](https://github.com/skein-js/skein-js/tree/main/examples/a2ui).
It streams surfaces, saves them in graph checkpoints, routes generated controls into new runs and
resumes a separate approval step. It uses existing Agent Protocol SSE and the JavaScript SDK.

## Try the complete journey

Use Node 26, clone the repository, then run these commands at its root:

```sh
pnpm install
cd examples/a2ui
pnpm dev:all
```

Open **http://127.0.0.1:3007** and select **Send**. Review the saved UI with
**Approve UI** or **Reject**, then use its generated revision button or feedback field.
**Dismiss notes** deletes one surface without regenerating the UI. Reload its thread URL
to restore the saved surfaces, prompts and pending review without executing the graph.

![The Angular chat playground](/images/a2ui/trip-planner.png)

The default generator emits scripted UI samples and needs no credentials. To use a live
model, copy `.env.example` to `.env`, set `A2UI_MODEL` to a LangChain `provider:model` string, supply
the provider's credentials and restart the backend. The Google integration is installed; add the
appropriate LangChain integration for another provider. Sample data is illustrative.
Approval records a decision and submits no external action.

The included `@langchain/google` integration accepts `google:model`; existing
`google-genai:model` settings use it as an alias. Credentials stay on the backend.

## Use the chat playground

Choose a **Website traffic dashboard**, **UI feedback form** or **Product comparison cards**, or describe an interface and select **Send**. The response renders inline; the read-only JSON panel shows the current validated UI. Approve or reject the saved version, then continue in chat or use its generated revision controls.

The default runs offline using three illustrative layouts. A live model accepts other prompts within the registered catalog; it cannot emit arbitrary executable code. Configure it using the model instructions below.

Reload the chat URL to restore saved prompts, the active UI and pending review without execution. Each completed turn retains its validated UI snapshot. Earlier responses remain visible with read-only controls; only the latest UI accepts actions. Older prompt-only turns show a notice. **New chat** starts a separate thread.

## Bring the pattern into your application

Start with an Angular 21 application and a Skein-hosted LangGraph graph. The tested renderer requires
Angular `^21.2.5`; the example pins Angular and its build/compiler tooling to 21.2.25. Install these
integration dependencies in the appropriate graph and frontend dependency owners:

```sh
npm install @a2ui/angular@0.14.0 @a2ui/web_core@0.15.0 @a2ui/agent@0.1.0 \
  @langchain/langgraph-sdk@1.12.7 zod@4.6.7
```

Use the example's graph, contract and session modules as the reference. Keep server generation
imports out of the frontend; the browser uses the core processor and Angular renderer.

### Register and render components

Register the upstream `BasicCatalog` through `provideA2UI`, with `useUniversalComponents: false`
for native Angular components. Release 0.14.0's default v1 catalog entries are universal-only.
The example's `createUiCatalog` uses public component overrides to pair v1 Basic Catalog schemas
with the package's exported native Text, layout, Button, TextField and Divider implementations
from `@a2ui/angular/v0_9`. It retains the v1 catalog ID and wire format; browser coverage verifies
this specific combination. Mount its `SurfaceComponent` for each active surface. In this
pinned release, that component's selector is `<a2ui-v09-surface>` even for A2UI 1.0.
The small `UiTextField` override retains upstream field binding and input handling while associating
the label with its input, which the pinned native field's template omits.

Use standalone components, OnPush and zoneless change detection. The example's Angular service
adapts a framework-independent SDK session into signals. Its action callback forwards the upstream
resolved action payload to the session; it does not implement a renderer or data-binding engine.

The example supports Text, Column, Row, Card, Button, TextField and Divider, with `reviseUi` and
`dismissNotes` event actions. Render historical surfaces with `sendDataModel: false` so revisions submit
only the current generation’s bound data. It rejects function calls, navigation and custom catalogs. Its
`provideMarkdownRenderer` implementation escapes text; the optional Markdown package is omitted
because its declared core peer range does not match the pinned core package.

### Compile model output on the server

Use `A2uiGenerator` and `CatalogConfig` with the registered catalog. Create a request processor
negotiated against the renderer's capabilities and select `DirectJsonFormatFactory` with
`progressiveKeys: []`. Its `promptSnippet` supplies upstream format and catalog instructions.
Add your application policy, surface identities and a short valid response example to that prompt.

Feed model text fragments through `openStream().feed(text)` and finish with `close()`. Consume
the returned `a2ui` parts, which contain complete A2UI messages. The upstream stream handles partial
JSON, applies stateful catalog validation and checks completed component topology. Application
validation restricts the messages, actions and surfaces it permits.

The offline fixture goes through this same parser, with chunks split inside JSON tokens. Live
generation uses LangChain's model stream and passes the previous saved UI as context while building
a complete new generation. A failed generation leaves the previous checkpoint intact.

### Deliver A2UI over existing SSE

Write complete A2UI messages through LangGraph's `config.writer`. Wrap them in application-owned
events identifying a generation, contiguous sequence and start/message/complete phase. The
example's start event also distinguishes a replacement generation from an update to saved surfaces.

Submit a background run using `client.runs.create`, requesting `custom` and `values`, then observe
that run through `client.runs.joinStream`. Pass only selected root custom messages into the upstream
processor. The example ignores namespaced subgraph frames; maintain a separate controller if your
application renders another graph scope.

Skein endpoints return Agent Protocol SSE envelopes, not a bare A2UI or JSONL stream. The SDK handles
SSE parsing and transport retries. A2UI's transport-independent message contract allows this bridge;
no additional Skein endpoint is required.

### Send capabilities, form data and actions

Read renderer capabilities using
`processor.getRendererCapabilities({ versions: ["1.0"], includeInlineCatalogs: false })`.
Forward them under the application's `a2uiRendererCapabilities` metadata on generation requests.
Use the upstream generator to negotiate supported catalogs rather than rebuilding that logic.

For editable surfaces, set `sendDataModel: true`. On an action, call
`processor.getRendererDataModel("1.0")` and attach its snapshot as `a2uiRendererDataModel` alongside
the upstream action message. This carries local bound-field edits to the graph.

Validate action name, source component, current generation and the application values you accept.
The UI playground accepts feedback on its controls surface, checks that the submitted field and
resolved action agree, and maps that action into the next generation. Client metadata never decides
ownership. Keep the graph's input schema narrower than its saved-state schema.

### Checkpoint surfaces and review separately

Materialize one bootstrap `createSurface` message per active surface from upstream component and
data-model getters. Save this plain JSON, the generation ID and application snapshot version in
graph state. Do not checkpoint processors, signals or an unbounded message transcript.

After generation returns its validated state, run a separate node calling `interrupt()`. Trusted
application controls send `input: null` and an interrupt-ID-addressed `command.resume`. Validate
the decision and generation ID inside that node. Resuming review does not rerun generation.

The generated controls are disabled during previews, execution and pending review. Every new
generated UI is reviewed; dismissing notes only updates saved surfaces and retains the existing
UI decision.

Configure the SDK with `onRequest: prepareUiRun` from the example. SDK 1.12.7 does not serialize
`if_thread_status` from `runs.create` options, so this public hook inserts the existing wire field:
ordinary starts require `idle` or `error`, and resumes require `interrupted`. Combined with
`multitaskStrategy: "reject"`, this prevents a competing tab from overwriting a pending review.
The same hook assigns a retry-stable `Idempotency-Key`; see
[idempotent run creation](../agent-protocol.md#idempotent-run-creation-idempotency-key) for its scope
and retention limits.

### Restore and recover

- Reopen a thread with `threads.getState`. Rehydrate fresh processors from saved bootstrap messages
  and restore pending review from its interrupts. This read executes nothing.
- If a run is active, join that existing run. Reconnect with `lastEventId`; keep the same per-run
  processor and application sequence state. Drop duplicates before applying messages.
- On gaps, invalid messages or reordered delivery, abandon the preview and show the last committed
  UI. Reconcile terminal run state even when replay is empty or has no detectable gap.
- A custom `complete` event precedes checkpoint completion. Mark the UI saved only after reading
  the terminal run's checkpoint.
- Unmounting and **Pause updates** abort observation only. **Stop run** cancels with waiting enabled,
  verifies terminal status and reads saved state.
- Preserve the last committed UI on provider, validation and transport errors. Refresh the thread
  before retrying an uncertain submission.

The normal demo uses memory with `--no-persist`. Its state survives browser reloads only while the
backend lives. Use existing [durable deployment options](../deploy.md) for server restarts.
SQLite retains checkpoints and run records but uses process-local event history; reopening restores
the saved baseline rather than replaying old frames.

The demo `x-user` header asserts identity for learning purposes. Replace its Auth callback with
session/JWT verification and keep thread ownership checks. Narrow graph input and validated resumes
do not prevent separately authorized state-update APIs from changing state. The example records a
decision, not an immutable authorization to perform an external action.

## Tested versions and limits

| Dependency                                       | Tested version        |
| ------------------------------------------------ | --------------------- |
| A2UI wire protocol                               | `1.0`                 |
| `@a2ui/agent`, `@a2ui/web_core`, `@a2ui/angular` | 0.1.0, 0.15.0, 0.14.0 |
| Angular framework, compiler and build tools      | 21.2.25               |
| `@langchain/langgraph-sdk`                       | 1.12.7                |
| `@langchain/langgraph`, `@langchain/core`        | 1.4.12, 1.2.18        |
| `langchain`, optional `@langchain/google`        | 1.5.10, 0.2.12        |
| Application Zod                                  | 4.6.7                 |

| Feature            | Supported behavior                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Generation         | Fragmented Direct JSON, offline fixture and optional LangChain model stream                      |
| Surfaces           | Create, component/data updates and deletion across canvas, controls and notes                    |
| Inputs and actions | Native bound TextField, `reviseUi` and `dismissNotes` events                                     |
| Review             | Checkpoint first, then interrupt-ID-addressed approval or rejection without regeneration         |
| Recovery           | Reconnect to the same run, explicit cancellation and checkpoint restoration after missing events |
| Persistence        | Memory for the demo; SQLite close/reopen with a fresh event bus                                  |
| Rendering          | Native Angular with the documented overrides and escaped plain text                              |

These versions establish this Angular/root-stream integration and application snapshot schema
version 2. They do not establish full A2UI conformance or compatibility with future releases.
Incompatible snapshots show an error and offer **New chat**; the example does not migrate them,
overwrite them or regenerate on reopening. Unsubmitted local form edits are not checkpointed.

### A2A interoperability is separate

This recipe verifies the Agent Protocol SSE bridge. Skein's current A2A binding advertises the
history-scope extension and converts message streams; it does not map these custom frames to A2UI.
A future binding must preserve per-turn `a2uiRendererCapabilities` and `a2uiRendererDataModel`, map
message lists to typed A2A DataParts with `metadata.mimeType: "application/a2ui+json"`, and implement
the selected version's optional extension advertisement/activation behavior. Existing MIME-mode
configuration alone does not implement that binding. See the
[A2UI A2A extension specification](https://a2ui.org/specification/v1.0-a2ui-extension-specification/).

Remote function RPC, custom catalogs, AG-UI, MCP Apps and a raw JSONL endpoint remain outside this
example's tested subset. The [json-render recipe](./json-render.md) demonstrates a separate UI format
using the same Skein lifecycle primitives.
