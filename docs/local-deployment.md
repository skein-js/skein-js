# Durable local deployment

`@skein-js/local` assembles the existing Agent Protocol engine with SQLite persistence and LangGraph's
SQLite checkpointer. Use the same graphs in a desktop application, terminal tool, separate daemon,
or server. The application chooses models and tools, including any connection to a local model.

## Embed agents

```sh
npm install @skein-js/local @langchain/langgraph @langchain/langgraph-checkpoint-sqlite@~1.0.4
```

```ts
import { embedSqliteGraphs } from "@skein-js/local";
import { createProtocolRuntime } from "@skein-js/agent-protocol";

const local = await embedSqliteGraphs(
  { assistant: graph },
  {
    sqlitePath: "/absolute/application-data/state.sqlite",
    // maxPageSize, ttl, threadTtl and non-owned ProtocolDeps overrides are optional.
  },
);
const runtime = createProtocolRuntime(local.deps);
await runtime.service.assistants.registerGraphAssistants();
runtime.worker.start();

// Use runtime.service, or give local.deps to an existing framework adapter.
// The host stops its worker/adapter before disposing owned resources.
await runtime.worker.stop();
await local.dispose();
```

The helper starts no assistants, workers, listener, application process or global signal handler.
It owns storage and a small item-expiry timer. The existing protocol runtime owns the scheduler,
thread-retention sweep, idempotency sweep and delivery worker. An adapter manages that runtime's
lifecycle through its existing APIs. `dispose()` is idempotent.

For direct storage use, `openSqliteStorage` from `@skein-js/storage-sqlite` returns the existing
`store` and `queue` contracts, the borrowed native `database`, and `dispose()`. The helper's
`sqlitePath` and driver's `filename` must be absolute. Both create the requested parent directory.
Do not close or change ownership settings on the borrowed connection.

`overrides` retains existing auth, logger, clock, telemetry, webhook and external `storeItems`
injection. The owned graph/storage/queue/bus/checkpointer bindings cannot be replaced there.
The two libraries do not install server-kit, schema/config loading, Postgres, Redis, BullMQ or HTTP
adapters. Add an existing adapter when a transport is needed.

## CLI and scaffolding

```sh
npm create skein-js@latest my-agent -- --storage sqlite
cd my-agent
npm run dev
npm run build
npm start
```

Or select the SQLite pair on an existing project:

```sh
skein dev --store sqlite --queue sqlite
skein start -c .skein/build/langgraph.json --store sqlite --queue sqlite
```

Install `@skein-js/local` and the saver in the project first. Both commands accept `--sqlite-path`;
the CLI resolves it against the working directory and defaults to `.skein/state.sqlite` there.
The file remains outside the build artifact. SQLite does not import memory development snapshots.
Mixed SQLite/non-SQLite store and queue pairs are refused. Existing command defaults remain unchanged.
The LangGraph import command retains its memory and Postgres targets.

The config path keeps auth, channels, telemetry, retention and external-store configuration. SQLite
provides text/filter search and rejects `store.index`; configure an external semantic store through
its existing adapter seam. SQLite scaffolds omit Compose and external-service environment settings
and include `dev:memory` as an alternative. The scaffolder adds no desktop-framework or model axis.

## What survives a process ending

| Driver | Unclaimed queued work               | Abandoned executing attempt                                | Stream frames                |
| ------ | ----------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| Memory | Lost with the in-memory queue       | No durable failure accounting                              | Process-local                |
| SQLite | Persists with its original due time | Existing `error` status with `ProcessLostError`; no replay | Process-local                |
| Redis  | Persists in Redis                   | Existing BullMQ stalled-job/redelivery behavior            | Existing Redis bus retention |

SQLite holds exclusive file ownership from an initialization write until disposal. A second owner
is refused; an OS process exit releases the lock. Startup examines abandoned runs and queue claims
in internal batches without the public page cap. Pending inline requests also become failures.
Terminal outcomes, including real approval interruptions, retain their results. Saved values,
checkpoints and interrupt payloads remain available through existing state/history APIs.

Run creation records server-owned background intent and its absolute due time. SQLite commits the
run, kwargs and queue job together, including guarded admission and cron claims. Enqueue deduplicates
without shortening delays. Cron jobs remain immediately eligible; cron `after_seconds` remains ignored.

Failure accounting does not retry input, resume a checkpoint, cancel a thread's pending backlog,
or reconstruct a successful outcome. Applications use existing run/state APIs to make those choices.
Reconciliation does not synthesize completion callbacks, telemetry or application cleanup. Previously
committed delivery records remain eligible for the existing polling retry worker after restart.

## Desktop and daemon hosts

The maintained consumers are distinct applications:

| Consumer                                                                             | Application                          | Model tools and local actions                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------- |
| [Electron](https://github.com/skein-js/skein-js/tree/main/examples/desktop-electron) | **Daybook**, a meeting workspace     | Read project context, search earlier meetings, review and save follow-ups             |
| [Tauri](https://github.com/skein-js/skein-js/tree/main/examples/desktop-tauri)       | **Reading Room**, a document library | Read a source document, search the library, review a brief with exact source excerpts |
| [CLI](https://github.com/skein-js/skein-js/tree/main/examples/local-cli)             | **Dayplan**, a daily planner         | Read a selected task file and prior plans, review focus blocks, save a Markdown plan  |

From the repository on Node 24, install dependencies and choose a provider in desktop Settings or the CLI environment:

```sh
pnpm install
pnpm nx run example-desktop-electron:start
# Or:
pnpm nx run example-desktop-tauri:start
pnpm nx run example-local-cli:start
```

Desktop start commands package and open the applications; their first run requires native build
prerequisites and can take several minutes. The CLI starts directly. The examples offer **Vertex AI**, **Gemini API**, **OpenAI**, **Anthropic**, and **Ollama**. Desktop Settings configures the
provider, model and connection. The CLI uses environment variables:

| Provider   | Configuration                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Vertex AI  | `MODEL_PROVIDER=vertex`, Google ADC, optional `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` |
| Gemini API | `MODEL_PROVIDER=gemini`, `GOOGLE_API_KEY` (or `GEMINI_API_KEY`)                                  |
| OpenAI     | `MODEL_PROVIDER=openai`, `OPENAI_API_KEY`                                                        |
| Anthropic  | `MODEL_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`                                                  |
| Ollama     | `MODEL_PROVIDER=ollama`, optional `OLLAMA_BASE_URL` and `OLLAMA_MODEL`                           |

For Vertex, run `gcloud auth application-default login`; the app discovers a project from environment
or gcloud settings, or accepts one in Settings. No project name/ID is hardcoded. `MODEL_NAME` selects
a model; defaults are `gemini-3-flash-preview` for Google and `gpt-5-mini` for OpenAI. Provider-specific
`GOOGLE_MODEL`, `OPENAI_MODEL`, `ANTHROPIC_MODEL` and `OLLAMA_MODEL` also work. The Vertex region defaults to `global`. Cloud providers require valid access and available billing/quota. Explicit environment preferences override saved
UI preferences. UI-entered keys live only in backend session memory; only non-secret preferences
are persisted. Selected source material and tool results are sent to the selected provider. Anthropic defaults to `claude-sonnet-5-5`; Ollama defaults to `qwen3:8b` at
`http://127.0.0.1:11434`. Ollama needs an installed tool-capable model and no API key. The app never
downloads models automatically. All model names and the Ollama endpoint are editable. This is application code: Skein adds no
provider configuration or credential store. Model integration remains application-owned.

Desktop UIs use `@langchain/langgraph-sdk` over the existing HTTP/SSE adapter. Background
`runs.create` and `runs.joinStream` let preparation continue while the user navigates. Actual tool
activity and generated answers stream through `custom` and `messages` modes. Drafts autosave,
conversations persist in separate threads, and pending reviews reopen from SQLite checkpoints.
Approval sends `command.resume`; the host-selected local file action runs only after review.
**History and versions** shows actual requests, run status and checkpoints. **Create alternative**
uses thread copy and state-update APIs without replacing the original. Saved output is searchable
through Skein's shared store. These application features require no additional library API.
Normal launches use the real model. Keyless deterministic fixtures are explicitly selected only
by tests and packaging gates.

Hosts choose application-data paths, launch and shutdown behavior. A separate daemon uses the same
assembly; its host owns supervision, endpoint discovery and credential exchange. No CLI daemon
lifecycle or desktop-specific protocol is introduced. The examples bind loopback on an OS-assigned
port and use a per-launch bearer through existing auth, with `studioAuthDisabled: true`. Credentials
are passed through environment/private bridges, rather than command-line arguments or saved files.

The target matrix is Node 22/24, Electron 44 and Tauri 2 on Linux x64, Windows x64, and macOS ARM64/x64.
Packaged consumer gates install tarballs outside the checkout and exercise native addon loading,
writable data paths, streaming, approval resume and credential rejection. Platform support requires
those gates to pass on the corresponding runner; a source build alone supplies no packaging evidence.

Tauri packages an official portable Node 24 distribution, verified against its SHA-256 manifest,
plus the backend directory and native assets. Electron rebuilds the SQLite addon against its own ABI.
See [Tauri resources](https://tauri.app/develop/resources/) for the bundle mapping.
This release does not support SQLite in browsers, Bun/Deno or distributed workers, or promise a
single executable containing every native dependency. Size/startup measurements belong to the
specific packed consumer and platform; the smoke prints package bytes, assembly time and process RSS.

See the [validation record](./local-deployment-validation.md) for measured sizes and completed versus
pending platform gates.
