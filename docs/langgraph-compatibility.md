# LangGraph Agent Server compatibility

Use this reference before pointing an existing LangChain client at skein-js. Start with your current
`langgraph.json` and SDK, run a known input, and verify the behavior your application uses with
[project smoke tests](./testing-your-project.md#check-the-running-server).

## Verified client combinations

| Client or surface                   | Verified combination and behavior                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JavaScript SDK                      | Legacy SDK 1.9.25/1.9.31 and thread-protocol SDK 1.12.6; examples also use 1.12.7                                                                            |
| React                               | Dedicated `@langchain/react` 1.2.6 and 1.2.7; legacy SDK React hook remains supported                                                                        |
| Angular, Vue, Svelte                | Dedicated packages 1.2.6, exercised in Chromium                                                                                                              |
| Thread subscriptions                | Multiple turns, restoration, interrupt/resume, cancellation, and reconnect; reconnect does not start another run                                             |
| Cross-instance reconnect            | Express with Redis queues and thread event buses                                                                                                             |
| Memory and retention options        | Memory, SQLite, and Postgres store indexing, write TTL, and per-read refresh controls                                                                        |
| MCP                                 | Legacy SDK 1.32.1 ordinary calls; server/client 2.4.0 with explicit revision 2026-07-28 negotiation for form/URL and tool-review rounds                      |
| A2A                                 | Official A2A SDK 1.3.0, retained task output and interrupt handling                                                                                          |
| Compiled UI and custom applications | UI compiler 1.4.2; Node 24 production artifact with SQLite                                                                                                   |
| json-render integration             | Core/React 0.21.4, SDK 1.12.7, React 19.2.6; root custom stream, saved specs, actions and interrupt/resume                                                   |
| Diagnostics                         | Checkpoint payload accounting with memory, SQLite, and Postgres; Prometheus and OTLP JSON output                                                             |
| Deep Agents                         | Retained 1.15.1 consumer; isolated 1.16.3 with LangChain 1.6.2, Core 1.3.5, LangGraph 1.6.1, SDK 1.12.7 and QuickJS 0.6.6                                    |
| Redis worker recovery               | Postgres checkpoints + Redis redelivery after process loss; accepted input/commands are not submitted as a new turn                                          |
| Separate API/background processes   | Public Postgres/Redis runtime composition, authorization, cancellation, stream reconnection and shutdown; wait/stream stay inline                            |
| Configuration controls              | Compatible webhook headers/templates/URL restrictions, configurable/logging headers, disable_webhooks and disable_ui; legacy Skein controls remain supported |

These combinations establish the listed behavior, rather than universal compatibility with every
version or backend. Agent Protocol fixtures use LangGraph.js 1.4.7; a packed consumer uses 1.4.12.
Thread-event execution requires LangGraph's public `streamEvents({ version: "v3" })` capability;
legacy execution remains available for older graphs and custom agents.

For frontend setup, use [the SDK guide](./react-sdk.md). For configuration and exact wire contracts,
use [CLI compatibility](./langgraph-cli-compat.md) and the [protocol reference](./agent-protocol.md).

For human input, follow the [MCP recipe](./recipes/mcp-human-input.md). Memory and SQLite reopening
exercise retained rounds; Postgres/Redis runtime artifacts exercise the official client on Node,
Bun and Deno. Custom stores without paired optional immutable-result read/write capabilities keep
ordinary calls but return an explicit error for resumable input. Legacy clients receive an explicit
error when a tool pauses. They do not silently complete that tool.

The [Deep Agents recipe](./recipes/deep-agents.md) describes skills, files, permissions, summarization,
offloading, interpreter, async tasks and binary state. Binary state reopens from a real SQLite file.
Remote sandbox integration is verified with the public upstream backend and a deterministic HTTP
provider; the credential-gated live LangSmith smoke test is separate and has not been run in this
closeout. No claim is made about live provider availability or sandbox security policy.

## Client limitations

- **Svelte 1.2.6:** root `useImages` returns an empty projection. Use a scoped media selector for the
  subgraph namespace containing the media.
- **Vue 1.2.6:** unwrap a media asset with `toRaw(asset)` before reading `blob`; see the
  [frontend workaround](./react-sdk.md#dedicated-framework-packages).
- **Development UI watchers:** follow the upstream watcher's process lifetime. Your host owns shutdown.
- **Deep Agents 1.16.3:** use explicit async URLs and caller-scoped credentials. URL-less automatic
  parent notification has no public caller-scoped transport hook; use polling or the
  [authorized parent-notification recipe](./recipes/deep-agents.md#notify-a-parent-through-http).
- **Custom savers:** inject them [programmatically](./embedding.md#supply-an-upstream-saver), including
  host-owned setup and disposal. Non-default config loaders are diagnosed rather than ignored.

## Intentional differences

- HTTP/SSE is supported; WebSockets and gRPC are outside the compatibility target.
- Stateless runs keep their threads by default. Set `on_completion: "delete"` to remove them.
- Store ordering filters compare numbers only.
- Local SQLite persists resources and checkpoints; event replay is process-local and is lost on restart.
- SQLite abandoned attempts become failures; recovery is application-controlled. Redis workers can
  continue attributable checkpoints, but uncommitted external effects can repeat. See
  [recovery](./runs-and-redis.md#recover-after-a-worker-exits).
- Legacy run endpoints default to `reject`; thread commands default to `enqueue`. Set an explicit
  strategy when migrating. Existing [queue ordering limits](./runs-and-redis.md#run-concurrency)
  remain; this program does not add a stronger FIFO contract.
- Skein adds idempotent run creation and durable, signed, retried webhook delivery. LangGraph also
  supports ordinary run-completion webhooks.
- Managed hosting, billing, evaluations, and application identity policy remain application or
  service choices.

<span id="implementation-evidence-23-october-2026"></span>
<span id="frontend-example-refresh-25-october-2026"></span>

Contributor investigation and dated test evidence are recorded in the
[testing guide](https://github.com/skein-js/skein-js/blob/main/docs/testing.md#recorded-compatibility-evidence).
The [9 November closeout record](./audits/agent-server-closeout-2026-11-09.md) maps each epic acceptance
case to its implementation, boundary and verification status.
