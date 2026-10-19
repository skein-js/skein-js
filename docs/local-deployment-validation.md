# Local deployment validation

Recorded on 2026-10-19 on macOS ARM64. These are measured results for this implementation, not
throughput, footprint or cross-platform support guarantees.

## Completed checks

- Shared SQLite resource/queue conformance and driver regressions: 218 passed, one existing shared
  case skipped. Covers real files, retained delays, deduplication, guarded/CAS admission, migrations,
  exclusive ownership, configured retention, bounded reconciliation and disposal.
- Local assembly/checkpointer regressions: six passed. Covers actual approval resume after reopen,
  state/history, copy, fork, prune, rollback, deletion, retention cleanup and durable outbox polling.
- Separate subprocess kills before enqueue, before/after commit, after claim, and during an actual
  LangGraph run. The real graph retained its checkpoint and its original input was not replayed.
- Affected adapter suites, including terminal stream replay with lost completion state, all five
  transports and both Next.js boundaries.
- Existing Postgres/Redis integration suites: 490 passed, two existing cases skipped.
- Existing Node/Bun/Deno server conformance matrix: 14 checks per runtime, all passed. SQLite remains
  Node-only.
- Clean packed-library and generated SQLite project installs outside the checkout on Node 22.23.3
  and 24.15.0. Declaration consumption, built import/require, dependency closure, scaffold tests,
  artifact build, dev and start all passed. Packed-consumer gates use npm 11 for file overrides.
- Packaged Electron 44.9.0 utility-process and Tauri 2/portable Node 24 backend launches passed on
  macOS ARM64. Both streamed progress, resumed approval, saved Markdown meeting recaps under isolated host-data
  paths, and rejected missing credentials and forged Studio headers.
- Affected lint, typecheck and build passed across 47 projects. Next.js builds use `NODE_ENV=production`.
- Affected ordinary tests passed: 2,307 cases across 16 projects. Nx formatting checks passed.
- Local application tests: 18 passed. Covers meeting/reading/planner reviews across SQLite reopening,
  edited approval, immutable recap revisions and identical-content reuse, dismissal without output,
  source preservation, and credential-safe provider settings.
- Live Gemini 3 Flash verification passed with automatic Google Cloud project discovery: all three
  applications called real tools, generated reviews and saved approved output. Desktop assistant
  conversations streamed and persisted through the existing SDK. No project ID is hardcoded.
- Vertex AI, Gemini API, OpenAI, Anthropic and Ollama are selectable through UI/environment settings.
  SDK request tests cover API-key routing, GPT-5 token parameters, Anthropic headers, Ollama endpoint
  selection/tool probes, rejected credentials and non-secret preference restoration. Live OpenAI and
  Anthropic generation was not checked because corresponding funded keys were unavailable.
- The installed Ollama models reported completion/vision capabilities without tools. A real local
  server check confirmed the UI rejects a model without tool support; no model was downloaded.
  Full local generation requires installing a compatible model such as `qwen3:8b`.
- Both desktop interfaces were exercised against real SQLite/Vertex backends: autosave, actual tool
  activity, edited review/save, restored chat, independent checkpoint alternatives, provider switching
  and dynamic project selection. Normal apps use real models; deterministic fixtures are explicit.
- Updated packed Electron 44.9.0 and Tauri 2 launches passed on macOS ARM64 with all five provider
  integrations installed from declared dependencies outside the checkout. The reading proof covers
  source excerpts, library search and chat; both hosts reject missing/forged credentials on model
  settings routes as well as their ordinary authenticated protocol workflows.

Test-only build dependencies ensure package/export checks inspect both built libraries rather than
skipping absent output.

## Measurements

One clean packed-library sample per Node version, after imports and graph construction:

| Measurement                        | Node 22.23.3      | Node 24.15.0      |
| ---------------------------------- | ----------------- | ----------------- |
| Local runtime assembly             | 9.73 ms           | 8.75 ms           |
| Process RSS at assembly completion | 123,551,744 bytes | 159,350,784 bytes |

Assembly timing excludes process/module startup and the first graph run. RSS includes Node and
loaded dependencies, and is not incremental library memory. These single samples do not establish
a performance comparison.

Packed npm artifacts measured 6,500 bytes for `@skein-js/local` and 13,894 bytes for
`@skein-js/storage-sqlite`. Those figures exclude dependencies and native assets. The macOS Tauri
bundle measured about 327.86 MiB for Reading Room with five model integrations; a small library
tarball does not imply a comparably small desktop application.

## Platform gates still requiring their runners

The reusable local-deployment CI workflow covers Linux x64, Windows x64, macOS ARM64 and macOS x64,
Node 22/24, and packaged Electron/Tauri launches. Linux, Windows and macOS x64 native launches were
not executed on this ARM64 Mac. Their CI results remain acceptance gates; configuration alone is
not evidence that those platforms passed.
