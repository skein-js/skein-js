# Shared code for the local applications

Private example code used by three different apps:

- **Daybook (Electron):** meeting notes, project/archive tools, assistant chat, edited follow-ups.
- **Reading Room (Tauri):** local documents, library tools, source excerpts and reviewed reading briefs.
- **Dayplan (CLI):** a local task inbox, prior-plan tools, practical focus blocks and approval.

These are normal LangGraph applications hosted by `@skein-js/local`. Model/tool loops reuse
LangChain's `createAgent`; explicit workflow nodes handle input, review and local file actions.
Skein supplies the existing Agent Protocol, SQLite resources, queue and upstream checkpoints.
Nothing here adds a public library API or a new protocol.

`model-session.ts` selects Vertex AI (Google ADC), Gemini API, OpenAI, Anthropic, or Ollama using the normal LangChain
model integrations. Desktop Settings and environment variables configure provider, model, project
region and Ollama endpoint. API keys can be supplied through the UI or environment; UI keys live only in backend
session memory. Only non-secret preferences are persisted. Credentials never enter
protocol inputs or checkpointed configuration. Provider failures are surfaced rather than replaced
with simulated answers. Deterministic output is limited to explicit tests and packaging proofs.

The desktop shell uses the LangGraph SDK for autosaved drafts, search, background runs, SSE,
chat threads, checkpoints, approval resume and alternative branches. Normal UI screens show the
application's work; **History and versions** supplies an optional view of the actual protocol.
Assistant conversations have separate threads so chat cannot accidentally resume a pending review.
Reviewed recaps and reading briefs use content-based revision filenames: a changed approval writes
a new file, identical content reuses its file, and the archive points to the latest approved revision.

```sh
pnpm nx test example-local-workflow
```

Tests reopen pending meeting, reading and planner reviews from real SQLite files, apply user
corrections, verify source preservation, and check that dismissal does not write an output.
Native consumer gates additionally check packaged addons and authenticated SDK workflows.

With a funded provider account and credentials, verify actual model/tool execution in all three apps:

```sh
pnpm nx run example-local-workflow:verify-models
```

This opt-in target makes live model calls using fictional source material. It checks tool execution,
streamed chat, reviewed file output and an unchanged task inbox; it is separate from keyless CI.

The Google defaults are Gemini 3 (`gemini-3-flash-preview`), OpenAI defaults to `gpt-5-mini`,
Anthropic to `claude-sonnet-5-5`, and Ollama to `qwen3:8b`. Model names are editable. Ollama
requires an installed tool-capable model and never receives the configured cloud API keys.
