# MCP human-input rounds

Design audit: **PASS**, 2026-11-09. One serial verifier and independent auditors A–F
returned no blockers before implementation; see the [audit record](../audits/mcp-human-input-2026-11-09.md).

Concrete design for the MCP workstream of #83. This does not add an application approval
workflow: it translates existing graph interrupts through the official MCP protocol.

## Consumer and validation-first gate

The consumer is an unchanged graph using `interrupt`, LangChain HITL middleware, or
`@langchain/mcp-adapters`, called by an official MCP client. A second consumer is the retained
1.x MCP client calling an ordinary non-interrupting graph. Before shipping, an isolated official
`@modelcontextprotocol/server` / `client` 2.4.0 consumer must prove revision 2026-07-28 form and URL
round trips and legacy fallback. If public SDK APIs cannot serve both, stop the implementation
and retain the existing endpoint with explicit unsupported-interrupt errors; do not clone MCP.

## Capability inventory

- Serve modern and legacy MCP requests using the official SDK's per-request HTTP handler.
- Translate string, relayed form/URL, and LangChain tool-review interrupts into elicitation requests.
- Bind paused rounds to authenticated callers, tool names, arguments, runs, and checkpoints.
- Resume through authorized inline run handlers, and replay a completed round without executing twice.
- Expire and erase paused and completed round records with their owning threads and runs.
- Return explicit errors to clients unable to answer the pending interrupts.

## Claim ledger

- The installed 1.32.1 MCP SDK does not implement protocol revision 2026-07-28.
- The public server/client 2.4.0 SDK implements that revision and stateless legacy fallback on Node 20.
- The existing authorized table can create/read/delete threads, invoke wait runs, and read run status/state.
- Wait calls execute inline and return a server-owned Content-Location identifying their run/thread.
- Existing optional RunRepo recordResult/getResult can retain immutable checkpoint/interrupt output.
- Existing required IdempotencyRepo claim/record/get supports durable scoped state and concurrent deduplication.
- Existing verifyResumeTarget checks the expected interrupted run and checkpoint under an execution lease.
- The installed @langchain/langgraph-api 1.4.2 does not implement local MCP serving.

## Permanent surface

No named export, route, configuration key, or required driver method is added. `/mcp` additionally
speaks the official 2026-07-28 envelope and its standard `resultType: "input_required"`, `inputRequests`,
`inputResponses`, and `requestState` fields. All fields are owned by the SDK. Existing 1.x clients,
assistant discovery, normal result content, and inline execution remain supported. The only dependency
change is official MCP server 2.4.0 (Node >=20); the old SDK remains a test consumer. Protocol installation
must remain independent of LangGraph execution packages. Keep this wire capability permanently once shipped.

## Design

Use `createMcpHandler` and `Server` from `@modelcontextprotocol/server`, with its automatic response
mode (JSON when no related notifications are emitted). Preserve JSON responses on the legacy path using the SDK's public
`isLegacyRequest` and `WebStandardStreamableHTTPServerTransport({enableJsonResponse: true})` composition;
the built-in legacy fallback otherwise chooses SSE. Register tools/list and tools/call through one factory.
The SDK classifies versions, validates envelopes and supplies capabilities, cancellation signals,
input response helpers, elicitation constructors, and JSON Schema validation. Skein checks the
documented URL scheme/credentials/length restrictions itself; SDK URL syntax validation alone is
insufficient. Import public entrypoints only. The official client must opt into modern negotiation
(`versionNegotiation: { mode: "auto" }` or a pinned revision); its default remains legacy.

An ordinary tool call still invokes the authorized wait handler. A trusted internal MCP origin marker
causes execution to retain the existing optional RunResult. A store lacking those optional methods can
still execute ordinary calls; if it pauses, answer with an explicit unsupported-resumption error.
Keep all MCP origin helpers and persisted fields out of package indexes and exported RunKwargs.
No required method is introduced. Preserve legacy thread retention rather than copying upstream's
unrelated delete-after-success behavior.

For a paused modern call, build questions from the immutable run result. String questions use one
`response` string field. Relay `mcp_elicitation.requests` in either array/snake_case or map/camelCase
shape. Validate supported form schemas and safe URL shapes with public SDK validators; do not fetch
schema references or URLs. Convert LangChain batched `actionRequests/reviewConfigs` (and snake_case)
into one form per proposed tool call. Only allowed decisions are offered. Edits retain the reviewed
tool name and require JSON object arguments; respond requires text. Unknown interrupt shapes and
static breakpoints receive actionable error results. Application approval policy remains graph-owned.

Use deterministic question hashes and per-interrupt prefixes to keep replayed questions stable and
parallel tool calls distinct. One round gathers all pending questions. Missing answers reissue the same
round/state. Ignore unrequested answer keys. Validate every supplied answer before resuming anything;
invalid answers return SDK InvalidParams (-32602/HTTP400), leaving a resumable round open. Decline/cancel
on relayed questions passes through; string cancellation or denied tool review ends the tool call with
an error, without treating a question as approved.

`requestState` is an opaque 256-bit random identifier, never serialized graph state or caller input.
Its server-side record lives in the existing IdempotencyRepo under a distinct internal scope containing
the authenticated identity and a canonical hash of tool name + arguments. Lookup verifies expiry before
using any record. Tampering, another identity/tool/argument set, erased resources, or a superseded
checkpoint fails closed. All replays re-enter authorized thread/run reads. Trusted resume origins reuse
`verifyResumeTarget` under the existing thread execution lease before invoking the graph. Client JSON
cannot manufacture the internal origin marker. Runtime context is allowed to change between rounds.

Each answer round uses a separate idempotency claim and records its immutable tool result or next
question round. A trusted `mcp_origin.roundState` is persisted in run kwargs at admission, before
invocation. Retry rediscovery uses existing listByThread/getKwargs and optional getResult: an existing
terminal attempt supplies its immutable output; a pending/running attempt or a missing result produces
an explicit retry/recovery error instead of another submission. Concurrent/repeated responses cannot
reapply the same resume input. Cross-instance exclusion relies on the existing backend execution lease.
This does not add automatic recovery of process-lost inline work or exactly-once external effects.
Refuse a changed answer to an already accepted round.

Pending round records expire after at most 24 hours, completed replays after at most 10 minutes, both
bounded by existing thread TTL and configured idempotency retention. Existing sweepers reclaim records;
request-time expiry checks make them immediately unusable. Set run/thread ownership on records so
existing erasure removes them. Do not add a scheduler, secret setting, database table, or workflow policy.

For modern callers, missing form/URL capabilities produce the SDK's MissingRequiredClientCapability
error (-32021). Legacy clients get an explicit tool error on a dynamic pause, while unchanged successful
calls retain their content. Preserve authentication before any tool action and authorization on every
thread/run access, including cached answers. Cancellation must close the inline execution through its
existing signal; later answers cannot revive cancelled or superseded work.

## Acceptance and blast radius

Official modern and legacy clients must pass discovery, normal calls, tool approval/edit/reject/respond,
parallel questions, relay form/URL, missing/invalid/first-call answers, duplicate and concurrent retries,
caller/tool/argument tampering, expired states, revocation, erased threads, stale checkpoints,
cancellation, and capability errors. Run memory/SQLite/Postgres conformance and packed standalone
protocol consumers. All framework adapters share the same table; run adapter suites, HTTP artifact
matrix, and Node/Bun/Deno builds. No schema migration, required custom-driver method, new CLI role,
background execution policy, process-global transport replacement, or deployment authorization policy.

The external packed compatibility consumer must host an unchanged LangGraph question and a LangChain
tool-review graph, invoke them with the official modern client, and assert final answers/tool arguments
and a single resume effect under duplicate/concurrent responses. The retained official legacy client
must still execute its ordinary graph and receive an explicit interrupt error. Cover stores with neither
optional result method and each partial capability independently.

Adopter docs explain client prerequisites, supported interrupt shapes, expiration, explicit errors,
custom-store capabilities, and existing run/thread alternatives. Evidence belongs in the dated closeout
ledger. The old Deep Agents 1.15.1 consumer remains isolated from the new candidate's peers.

## Verified premise sheet (2026-11-09)

Independent verifier: `/root/verify_mcp_design`, read-only. The isolated official-client proof at
`/private/tmp/skein83-mcp-proof/proof.mjs` additionally passed form+URL auto-fulfillment at revision
2026-07-28 and legacy 1.32.1 fallback through public SDK 2.4.0 APIs.

| Premise                        | Probe and result                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Old SDK revision               | `rg LATEST_PROTOCOL_VERSION node_modules/.pnpm/@modelcontextprotocol+sdk@1.32.1*/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`: `2025-11-25`; no 2026 revision.                                                    |
| Modern SDK shape               | Packed server2.4.0 manifest: `node >=20`; public `createMcpHandler` declaration: `legacy?: 'stateless' \| 'reject'`, JSON response mode. Client modern negotiation is opt-in.                                                  |
| Existing authorized operations | `create-handlers.ts` declares create/read/delete thread, getRun/getThreadState/createWaitRun; `auth/route-authz.ts` maps wait to threads/create_run and run reads to threads/read.                                             |
| Inline semantics               | `run-service.ts:createWait` awaits `runInline`, then returns runId/threadId/result; `create-handlers.ts:createWaitRun` emits server-owned Content-Location. Body contains values/error, not immutable interrupts.              |
| Optional immutable result      | `core/src/store/runs.ts` declares optional recordResult/getResult, first-write wins. Memory, SQLite, Postgres implement them; engine currently records native/A2A results only.                                                |
| Existing state storage         | `core/src/store/idempotency.ts` required claim/record/get and erasure. Postgres conflict-claim replaces only expired records; record checks claim_id but allows same-owner updates. Service must enforce immutability.         |
| Resume guard                   | `runs/resume-target.ts` checks latest interrupted run and current checkpoint; engine invokes guards inside `startRunExecution`'s lease. Cross-instance guarantees require threadExecutionGate.                                 |
| Inline crash limit             | wait idempotency records after execution, unlike background atomic admission. Required listByThread/getKwargs can rediscover a private origin persisted at pending-run creation; no automatic lost-inline recovery is implied. |
| Erasure                        | thread-service calls deleteByThread and run-service calls deleteByRun; physical erasure can be best-effort. Request-time expiry and fresh authorized reads remain mandatory.                                                   |
| SDK helpers                    | Public inputRequired.elicit/elicitUrl, inputResponse, specTypeSchemas, InvalidParams and MissingRequiredClientCapabilityError exist. Constructors do not validate answers; URL syntax alone is insufficient.                   |
| Installed upstream             | langgraph-api1.4.2 source: `Local MCP features are not yet supported with the JS CLI and will be ignored.` No universal claim about all upstream packages is made.                                                             |
