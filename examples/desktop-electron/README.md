# Daybook — a meeting workspace in Electron

Daybook is a small meeting-notes app: write or paste ordinary notes, ask the assistant questions,
and turn the conversation into a reviewed recap. The selected model reads project context and searches saved
meetings with real tools. You can edit the proposed summary, owners and dates before saving.

## Run it

Use Node 24, pnpm, and the native build prerequisites for your OS:

```sh
pnpm install
pnpm nx run example-desktop-electron:start
```

The command builds and opens a packaged Electron app. The first run installs a clean consumer and
rebuilds SQLite for Electron, so allow a few minutes. Closing the app stops the command.
Open **Settings** and choose **Vertex AI**, **Gemini API**, **OpenAI**, **Anthropic**, or **Ollama**. Choose a model and
enter an API key for Gemini/OpenAI/Anthropic, or supply it through the environment. For Vertex AI, run
`gcloud auth application-default login`; the project is discovered from environment/gcloud settings
or entered in the UI. No project name or ID is hardcoded. Vertex AI requires project access and billing.

Try **Try a launch check-in**, then **Generate recap**. Watch actual project/archive tools run,
check the draft, and choose **Approve & save**. Ask **What changed?** after saving a second meeting
to see the assistant consult the archive. **Project context** lets you supply your own team brief.

Regenerating and approving a recap saves a new Markdown revision and updates the archive to that
revision. Earlier files remain intact; saving identical approved content reuses its existing file.

Notes autosave locally. Close during a pending review and reopen to continue it. **Create alternative**
branches from the saved draft without replacing the original. **History and versions** shows the
real requests, run history and checkpoints; **Export Markdown** downloads your reviewed recap.
Model requests send the selected notes, conversation and tool results to your selected provider.
With Ollama, those requests go to your configured local server.

## How it is built

Electron 44 runs the existing HTTP/SSE adapter in a utility process. The sandboxed renderer uses
`@langchain/langgraph-sdk`; the preload bridge only supplies a URL and per-launch bearer.
`@skein-js/local` injects the SQLite store and upstream checkpointer into ordinary LangGraph graphs.
The meeting graph has read, model/tool, approval and save nodes. Assistant chat uses a separate
persistent thread so questions cannot consume an outstanding approval.

| App behavior                            | Existing protocol capability                      |
| --------------------------------------- | ------------------------------------------------- |
| Generate while navigating the workspace | Background `runs.create` + `runs.joinStream`      |
| Tool progress and streamed answers      | SSE `custom` and `messages` modes                 |
| Close and return to a review            | Persistent threads and checkpoint state           |
| Correct a draft before saving           | LangGraph interrupt + `command.resume`            |
| Explore another outcome                 | Thread copy, checkpoint history and state updates |
| Search earlier work                     | Shared persistent store                           |

The host chooses Electron's `userData` directory and owns shutdown. The backend binds loopback on
an OS-assigned port, rejects missing credentials and forged Studio headers, and keeps credentials
out of arguments and saved application files. Google manages ADC discovery and refresh for Vertex. Only provider/model/project/region/server preferences
are saved; UI-entered API keys stay in backend session memory and must be re-entered after restarting. Applications own retries; abandoned attempts are
recorded as errors and their input is not automatically replayed.

## Verify packaging

```sh
pnpm nx run test-support:test-local-electron
```

This keyless, explicitly selected test fixture checks packed dependencies outside the checkout,
native loading, streaming, edited approval, saved Markdown, branching, search and authentication.
Normal launches always use the selected real model. Set `SKEIN_KEEP_CONSUMER=1` to retain a proof bundle.
Generated macOS bundles are ad hoc signed; shipping apps own signing and notarization.

## Environment configuration

| Provider   | Variables                                                                              |
| ---------- | -------------------------------------------------------------------------------------- |
| Vertex AI  | `MODEL_PROVIDER=vertex`, optional `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, ADC |
| Gemini API | `MODEL_PROVIDER=gemini`, `GOOGLE_API_KEY` (or `GEMINI_API_KEY`)                        |
| OpenAI     | `MODEL_PROVIDER=openai`, `OPENAI_API_KEY`                                              |
| Anthropic  | `MODEL_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`                                        |
| Ollama     | `MODEL_PROVIDER=ollama`, optional `OLLAMA_BASE_URL`, `OLLAMA_MODEL`                    |

`MODEL_NAME` overrides the model. Defaults are `gemini-3-flash-preview` for Google and `gpt-5-mini` for
OpenAI. `GOOGLE_MODEL`, `OPENAI_MODEL`, `ANTHROPIC_MODEL` and `OLLAMA_MODEL` also work. Explicit environment preferences override saved
UI preferences. Without an explicit provider or saved choice, available API keys select a provider
(OpenAI, then Anthropic, then Gemini); an Ollama URL/model selects Ollama, otherwise the app offers Vertex AI. Keys are never saved to the application database.

Copy `examples/local-workflow/.env.example` to a private env file, then load it when starting:

```sh
pnpm nx run example-desktop-electron:start --args="--env-file=./examples/local-workflow/.env"
```

For local inference, start Ollama and pull a tool-capable model such as `qwen3:8b`, then choose
**Ollama** in Settings. The default server is `http://127.0.0.1:11434`; models are not downloaded
automatically. Connection checks reject models that do not accept tools. Anthropic defaults to
`claude-sonnet-5-5`. Every provider's model name is editable.
