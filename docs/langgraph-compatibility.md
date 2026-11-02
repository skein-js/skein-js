# LangGraph Agent Server compatibility

Use this reference before pointing an existing LangChain client at skein-js. Start with your current
`langgraph.json` and SDK, run a known input, and verify the behavior your application uses with
[project smoke tests](./testing-your-project.md#check-the-running-server).

## Verified client combinations

| Client or surface                   | Verified combination and behavior                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| JavaScript SDK                      | Legacy SDK 1.9.25/1.9.31 and thread-protocol SDK 1.12.6; examples also use 1.12.7                                |
| React                               | Dedicated `@langchain/react` 1.2.6 and 1.2.7; legacy SDK React hook remains supported                            |
| Angular, Vue, Svelte                | Dedicated packages 1.2.6, exercised in Chromium                                                                  |
| Thread subscriptions                | Multiple turns, restoration, interrupt/resume, cancellation, and reconnect; reconnect does not start another run |
| Cross-instance reconnect            | Express with Redis queues and thread event buses                                                                 |
| Memory and retention options        | Memory, SQLite, and Postgres store indexing, write TTL, and per-read refresh controls                            |
| MCP                                 | Official MCP SDK 1.32.1, stateless Streamable HTTP                                                               |
| A2A                                 | Official A2A SDK 1.3.0, retained task output and interrupt handling                                              |
| Compiled UI and custom applications | UI compiler 1.4.2; Node 24 production artifact with SQLite                                                       |
| Diagnostics                         | Checkpoint payload accounting with memory, SQLite, and Postgres; Prometheus and OTLP JSON output                 |

These combinations establish the listed behavior, rather than universal compatibility with every
version or backend. The workspace uses LangGraph.js 1.4.7 and a packed consumer uses 1.4.12.
Thread-event execution requires LangGraph's public `streamEvents({ version: "v3" })` capability;
legacy execution remains available for older graphs and custom agents.

For frontend setup, use [the SDK guide](./react-sdk.md). For configuration and exact wire contracts,
use [CLI compatibility](./langgraph-cli-compat.md) and the [protocol reference](./agent-protocol.md).

## Client limitations

- **Svelte 1.2.6:** root `useImages` returns an empty projection. Use a scoped media selector for the
  subgraph namespace containing the media.
- **Vue 1.2.6:** unwrap a media asset with `toRaw(asset)` before reading `blob`; see the
  [frontend workaround](./react-sdk.md#dedicated-framework-packages).
- **Development UI watchers:** follow the upstream watcher's process lifetime. Your host owns shutdown.

## Intentional differences

- HTTP/SSE is supported; WebSockets and gRPC are outside the compatibility target.
- Stateless runs keep their threads by default. Set `on_completion: "delete"` to remove them.
- Store ordering filters compare numbers only.
- Local SQLite persists resources and checkpoints; event replay is process-local and is lost on restart.
- Skein adds idempotent run creation and durable, signed, retried webhook delivery. LangGraph also
  supports ordinary run-completion webhooks.
- Managed hosting, billing, evaluations, and application identity policy remain application or
  service choices.

<span id="implementation-evidence-23-october-2026"></span>
<span id="frontend-example-refresh-25-october-2026"></span>

Contributor investigation and dated test evidence are recorded in the
[testing guide](https://github.com/skein-js/skein-js/blob/main/docs/testing.md#recorded-compatibility-evidence).
