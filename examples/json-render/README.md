# GitHub UI playground with React json-render and Skein

Give the agent a GitHub username or repository. It chooses public GitHub tools and streams a
model-generated view that you can review, refine, and reopen.

![The GitHub playground](../../docs/public/images/json-render/plan-builder.png)

## Run it

Use Node 26 and the repository’s pnpm version. Run these commands from the repository root.

```sh
pnpm install
cp examples/json-render/.env.example examples/json-render/.env
```

Set these backend values in `examples/json-render/.env`.

```dotenv
JSON_RENDER_MODEL=google:YOUR_MODEL_ID
GOOGLE_API_KEY=YOUR_API_KEY
```

Use a model that supports tool calling. The shared example package includes the Gemini integration
and accepts the `google-genai:` alias. If `GOOGLE_API_KEY` is missing or blank, Skein reports an error
when it loads the graph. GitHub requests use the
[anonymous REST API quota](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

```sh
pnpm --dir examples/json-render dev:all
```

Open **http://127.0.0.1:3006**. Nx starts the browser app and the graph server on
`127.0.0.1:2024`. **Ctrl+C** stops both.

## Try it

1. Ask for a dashboard for `skein-js/skein-js`, the profile for `@octocat`, or recently pushed
   repositories for `@torvalds`. Watch the UI and its read-only JSON panel update.
2. Select **Approve UI** or **Reject** to record a decision and enable the next turn.
3. Ask for a change in chat or submit a revision using the generated controls.
4. Use **Reopen this chat** to restore the saved responses and any pending review.

**Pause updates** disconnects the stream, **Reconnect** rejoins the same run, and **Stop run**
cancels execution. The graph retries an invalid spec once. If generation still fails, the last
saved UI remains available and you can retry the prompt from the composer.

## Follow the code

- The [shared GitHub agent](../github-playground/README.md) uses a model node to select tools and a
  LangGraph `ToolNode` to execute them. It feeds the results into a second model call for rendering.
- `catalog.ts` defines the React components and binds the generated button and form to `reviseUi`.
  `generation.ts` uses `catalog.prompt()` with a complete SpecStream example. The graph feeds the
  model's JSONL patches to the upstream compiler.
- `app/generated-ui.tsx` creates the React renderer once. The app supplies the action handler
  for the current saved view.
- `live-graph.ts` checks the server's Gemini settings and exports the graph from `ui-graph.ts`.
  The graph's `ToolNode` checks the revision against the saved generation and sends the feedback
  to the same model node as a chat prompt. The review node pauses after the new UI is saved.
- `ui-session.ts` uses the LangGraph SDK to submit prompts and revisions, restore saved views, and
  cancel runs.

## Persistence

The local run keeps checkpoints in memory until the backend stops. Choose a
[durable storage option](../../docs/deploy.md) to retain them across restarts. The demo identity
uses `x-user: demo-user`. Use verified session or JWT identity and keep thread ownership checks
when hosting the playground.

## Contributor checks

```sh
CI=true pnpm exec nx run-many -p example-json-render -t lint typecheck test build
pnpm exec nx run server-express:prepare-browser
pnpm exec nx run example-json-render:test-browser
pnpm exec nx run test-support:test-compatibility-consumer
```

Browser captures go to `dist/json-render-screenshots`. Automated renderer and consumer tests use
injected fixtures. See the [adoption recipe](../../docs/recipes/json-render.md) for the supported
versions and interfaces.
