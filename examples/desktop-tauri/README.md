# Reading Room — a personal reading library in Tauri

Import a text or Markdown document, explore its argument with a reading companion, and save a
brief containing key ideas, questions and exact source excerpts. This is a document application,
with a library sidebar, a reading pane, persistent conversation and a reviewed output.

## Run it

Install Node 24 and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS:

```sh
pnpm install
pnpm nx run example-desktop-tauri:start
```

The command packages and opens the app, including its Node backend. The first build needs a Rust
compiler and downloads dependencies; allow a few minutes. Closing the app stops the command.
**Settings** selects **Vertex AI**, **Gemini API**, **OpenAI**, **Anthropic**, or **Ollama**, with an editable model name.
Enter a cloud provider's API key in the UI or configure it through the environment. Ollama uses an editable server URL and no API key. For Vertex AI,
run `gcloud auth application-default login` and select your project and region. The app can discover
the project from environment/gcloud settings; no project is hardcoded. Vertex AI access and billing
must be enabled for that project.

Choose **Try a short article** for fictional sample material, or **Import document** for a `.txt`
or `.md` file under 30,000 characters. Ask **Explain the argument** or **Connect the ideas**. The selected model
calls `read_document` and `search_library` against the real local store. **Create reading brief**
produces a draft for review. Only exact quotes found in the selected source appear as excerpts.
Edit the takeaway, then **Approve & save** or dismiss it. Source material sent to the companion
is processed by the selected provider.

Return to saved documents through the library, search their titles and saved briefs, export
Markdown, or create an alternative from an earlier draft. Pending reviews and conversations
survive reopening. **History and versions** exposes actual Agent Protocol requests and checkpoints.

## How it is built

Tauri 2 packages an official Node 24 distribution plus a backend directory containing its native
SQLite addon. Rust owns process lifetime and gives the webview a private loopback connection.
The frontend uses the ordinary LangGraph SDK over the existing HTTP/SSE adapter.

The graph reads the source, runs a model with library tools, checkpoints for approval, then saves a
local Markdown brief and a searchable store item. Chat has a separate persistent thread. Background
runs, streamed messages, tool progress, state/history, interrupt/resume and branching all use the
existing Agent Protocol. No Tauri-specific agent protocol or model feature is added to Skein.

The host chooses Tauri's application-data path and passes a new bearer through private IPC and the
child environment. The backend rejects missing credentials and forged Studio headers. Model
credentials never enter graph input, checkpoints or application files. Crashes fail abandoned
attempts; applications choose whether to retry.

## Verify packaging

```sh
pnpm nx run test-support:test-local-tauri
```

The explicit keyless test fixture checks the packaged backend, writable data path, source excerpts,
streaming, approval, the saved brief, library search, persistent chat and credential rejection.
Normal launches use the selected provider. Portable Node archives are checked against published SHA-256 sums.
Run the gate on each target OS/architecture; a source build alone does not verify native packaging.

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
pnpm nx run example-desktop-tauri:start --args="--env-file=./examples/local-workflow/.env"
```

For local inference, start Ollama and pull a tool-capable model such as `qwen3:8b`, then choose
**Ollama** in Settings. The default server is `http://127.0.0.1:11434`; models are not downloaded
automatically. Connection checks reject models that do not accept tools. Anthropic defaults to
`claude-sonnet-5-5`. Every provider's model name is editable.
