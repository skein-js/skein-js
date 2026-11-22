# GitHub UI playground with Angular A2UI and Skein

Give the agent a GitHub username or repository. It chooses public GitHub tools and streams a
model-generated view that you can review, refine, and reopen.

![The GitHub playground](../../docs/public/images/a2ui/trip-planner.png)

## Run it

Use Node 26 and the repository’s pnpm version. Run these commands from the repository root.

```sh
pnpm install
cp examples/a2ui/.env.example examples/a2ui/.env
```

Set these backend values in `examples/a2ui/.env`.

```dotenv
A2UI_MODEL=google:YOUR_MODEL_ID
GOOGLE_API_KEY=YOUR_API_KEY
```

Use a model that supports tool calling. The shared example package includes the Gemini integration
and accepts the `google-genai:` alias. GitHub requests use the
[anonymous REST API quota](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

```sh
pnpm --dir examples/a2ui dev:all
```

Open **http://127.0.0.1:3007**. Nx starts the browser app and the graph server on
`127.0.0.1:2025`. **Ctrl+C** stops both.

## Try it

1. Ask for a dashboard for `skein-js/skein-js`, the profile for `@octocat`, or recently pushed
   repositories for `@torvalds`. Watch the UI and its read-only JSON panel update.
2. Select **Approve UI** or **Reject** to record a decision and enable the next turn.
3. Ask for a change in chat or submit a revision using the generated controls.
4. Use **Reopen this chat** to restore the saved responses and any pending review.

Use **Dismiss notes** to remove the saved notes surface without generating a new response. The renderer uses the upstream A2UI 1.0 Basic Catalog and native Angular components. Its [recipe](../../docs/recipes/a2ui.md#register-and-render-components) explains the native overrides.

**Pause updates** disconnects the stream, **Reconnect** rejoins the same run, and **Stop run**
cancels execution. A generation error preserves the last saved UI and keeps the prompt in the
composer for retry. Dismissing notes preserves text already entered in the feedback field.

## Follow the code

- The [shared GitHub agent](../github-playground/README.md) uses a model node to select tools and a
  LangGraph `ToolNode` to execute them. It feeds the results into a second model call for rendering.
- `generation.ts` supplies this example's renderer format. `ui-generation.ts` parses Direct JSON into A2UI messages and validates the three surfaces.
- `ui-graph.ts` exports the compiled graph. Validated renderer actions go to a LangGraph
  `ToolNode`. `reviseUi` sends feedback to the generation node and `dismissNotes` removes the
  notes surface. New generations checkpoint the UI before the review interrupt.
- `ui-session.ts` uses the LangGraph SDK for runs, restoration, and cancellation.
  `app/ui-session.ts` passes messages to the Angular renderer and tracks its mounted surfaces.
- `app/app.ts` composes the conversation, prompt composer, and JSON inspector. Each Angular
  component has its own inline template. `app/ui-surfaces.ts` mounts the A2UI surfaces.

The Angular wiring follows the [A2UI client integration guide](https://a2ui.org/guides/client-integration/#step-1-install-dependencies).
The demo uses the guide's Markdown provider hook with an escaped plain-text renderer.
The published Markdown adapter 0.2.2 declares a web core 0.14 peer. The Angular and agent SDKs
used here require web core 0.15.

## Persistence

The local run keeps checkpoints in memory until the backend stops. Choose a
[durable storage option](../../docs/deploy.md) to retain them across restarts. The demo identity
uses `x-user: demo-user`. Use verified session or JWT identity and keep thread ownership checks
when hosting the playground.

For SQLite, stop the default backend and run this command from `examples/a2ui`.

```sh
pnpm exec skein dev --host 127.0.0.1 --port 2025 --store sqlite --queue sqlite --sqlite-path .skein/ui.sqlite
```

## Contributor checks

```sh
CI=true pnpm exec nx run-many -p example-a2ui -t lint typecheck test build
pnpm exec nx run server-express:prepare-browser
pnpm exec nx run example-a2ui:test-browser
pnpm exec nx run test-support:test-a2ui-consumer
```

Browser captures go to `dist/a2ui-screenshots`. Automated renderer and consumer tests use
injected fixtures. See the [adoption recipe](../../docs/recipes/a2ui.md) for the supported
versions and interfaces.
