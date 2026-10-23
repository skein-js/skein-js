# LangGraph Agent Server compatibility

Baseline investigated on **22 October 2026**. A shared dependency or a route with a similar name
does not establish compatibility: the official client must exercise the behavior end to end.

| Surface                                           | Baseline                                      | Compatibility work                                                                                   |
| ------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Run-based JavaScript SDK and legacy React hook    | Supported                                     | Retain coverage for SDK 1.9.25 and 1.9.31                                                            |
| Thread event protocol                             | Not yet supported                             | SDK 1.12.6; protocol 0.0.20; subscriptions, commands, reconnect and restoration                      |
| Dedicated React, Angular, Vue and Svelte bindings | Not yet verified                              | Test each package at 1.2.6 in a real browser                                                         |
| Thread-wide legacy stream                         | Joins one run                                 | Add explicit `stream_modes` following without changing the existing default                          |
| Execution and checkpoint options                  | Partial                                       | Durability, task/checkpoint modes, recursive and namespaced state/history                            |
| Search and retention                              | Partial                                       | Projection, exclusion, extraction, state timestamps, per-operation store options and keep-latest TTL |
| MCP and A2A endpoints                             | Not implemented                               | Official transport SDKs over the existing authorized services                                        |
| Graph UI assets and `http.app`                    | Accepted configuration without implementation | Development loading and standalone production artifacts                                              |
| OpenAPI and `/docs`                               | Not implemented                               | Describe actual enabled routes and authentication                                                    |
| `/metrics` and thread storage reporting           | Not implemented                               | Existing OTel instrumentation and exact saver-backed payload accounting                              |

The versions above are **implementation targets**, not a claim that all of their features have
passed. The implementation updates this matrix with the corresponding test evidence.

## Intentional differences

- HTTP/SSE is the supported transport target; WebSockets and gRPC remain outside the compatibility
  program.
- Stateless runs keep their threads by default. Request `on_completion: "delete"` to remove them.
- Store ordering filters compare numbers only.
- Local SQLite persists resources and checkpoints; event replay is process-local and is lost on
  restart.
- Skein adds idempotent run creation and durable, signed, retried webhook delivery. LangGraph also
  supports ordinary run-completion webhooks.
- Managed hosting, billing, evaluations and application identity policy remain outside Skein.

See [the frontend guide](./react-sdk.md), [protocol reference](./agent-protocol.md),
[CLI compatibility](./langgraph-cli-compat.md), and
[issue #62](https://github.com/skein-js/skein-js/issues/62).

## Implementation evidence, 23 October 2026

The workspace exercises LangGraph.js **1.4.7**; the clean packed consumer pins **1.4.12**.
The thread-protocol binding uses public `streamEvents({ version: "v3" })` and requires that runtime
capability. The existing legacy execution path remains available for older graphs and custom agents.

| Scope                                                                      | Versions and backends exercised                                                                        | Evidence                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread subscriptions, commands, restoration, multiple turns and interrupts | JavaScript SDK 1.12.6 / protocol 0.0.20; Express + memory                                              | Official client HTTP tests in `thread-protocol.test.ts`                                                                                           |
| Reconnect across API instances, one queued execution                       | SDK 1.12.6; Express + real Redis queue and thread buses                                                | `thread-protocol.integration.test.ts`, including a proxy-forced reconnect                                                                         |
| Legacy protocol and adapters                                               | Packed SDK 1.9.25 / 1.9.31 clients and legacy protocol tests; Express, Fastify, Fetch, NestJS, Next.js | Existing adapter suites retained; dedicated framework browser coverage is listed separately below                                                 |
| Store indexing, nullable write TTL and per-read refresh                    | Memory, SQLite and real Postgres                                                                       | Shared store-options conformance; real SQLite reopen                                                                                              |
| MCP discovery and execution                                                | Official MCP SDK 1.32.1; stateless Streamable HTTP                                                     | Official client transport test; shared MCP/A2A HTTP checks across all five adapters                                                               |
| A2A output retention and interrupts                                        | Official A2A SDK 1.3.0; memory and reopened SQLite                                                     | Official client over HTTP; first-task output survives another turn and checkpoint pruning                                                         |
| Dedicated frontend bindings                                                | React/Angular/Vue/Svelte 1.2.6, SDK 1.12.6, Chromium; Express + memory                                 | Native HTTP streaming, restoration, interrupts, cancellation, multiple turns, subgraphs, custom channels, scoped media and proxy-forced reconnect |
| Compiled UI and custom applications                                        | Public UI compiler 1.4.2; generated Node 24 production image + SQLite                                  | Real build → artifact → image; UI bootstrap/assets, Fetch app, OpenAPI and docs without sources or optional UI compiler                           |
| Diagnostics                                                                | Memory, SQLite and real Postgres saver payloads; standard OTel metric reader                           | Actual buffer/blob/datum accounting; Prometheus and OTLP JSON serializers; explicit unsupported-capability errors                                 |

A separate packed consumer installs Skein tarballs outside the workspace and exercises SDK 1.12.6,
legacy SDKs 1.9.25 and 1.9.31, official MCP and A2A clients, and diagnostics over native HTTP with no
application transport shim. That gate passes. These checks establish the listed behavior only;
release also requires the full Nx quality gates. Svelte 1.2.6's root `useImages` selector returns an empty
projection in its own implementation; scoped media selectors pass. Root media from React, Angular
and Vue was also exercised while validating graph-scope message namespaces. Vue 1.2.6 media assets
require `toRaw(asset)` before accessing `blob`, because its reactive proxy breaks private fields.
The browser gate checks actual media bytes with that public Vue workaround. These client limitations
are tracked separately from server media delivery. Development UI watches currently follow the
upstream watcher’s process lifetime; applications own process shutdown.
