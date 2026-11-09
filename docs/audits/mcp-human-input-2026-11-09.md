# MCP human-input design audit

Target: [MCP human-input rounds](../proposals/mcp-human-input.md). Verdict: **PASS**,
2026-11-09; no override. One serial verifier and six independent dimensions ran before
implementation. A/B/C received stripped inventories and verified facts; D/E/F received the
proposal. No auditor graded another dimension. The original inline-crash premise was corrected
before fan-out; it is not a recovery guarantee. Public SDK feasibility passed before implementation.

The proposal contains the verbatim capability inventory and claim ledger, plus the verified
premise sheet. The isolated official client/server2.4.0 proof passed modern form+URL auto-fulfillment
and legacy1.32.1 fallback. Modern negotiation must be explicitly enabled on that client.

| Dimension / independent auditor   | Required artifact and disposition                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A ownership / mcp_audit_ownership | Rollability: modern serving, elicitation translation, continuation integrity, inline replay, owned-state lifecycle, and capability errors are existing library protocol plumbing. Applications compose authorized waits through handlers.handleMcp, but cannot supply trusted inline provenance checked under the execution lease. Build the private bridge; add no public resume interface. PASS. |
| B reuse / mcp_audit_reuse         | Opened SDK1.32.1/public server2.4.0, LangGraph1.4.7, LangChain1.5.10 HITL, public mcp-adapters source, langgraph-api1.4.2, existing Skein idempotency/results/resume/erasure. Reuse official handler/builders/capability errors/fromJsonSchema and existing verifyResumeTarget. MCPAdapter is client-direction integration. PASS.                                                                  |
| C policy / mcp_audit_policy       | Ledger: zero new config keys. AuthEngine owns resource access; graph owns decisions; existing TTL/idempotency settings bound transport caps; no automatic graph timeout/recovery. Anonymous deployments retain the existing shared principal scope. PASS.                                                                                                                                          |
| D permanence / mcp_audit_surface  | Ledger: zero new exports/routes/config keys/required methods. Standard resultType/inputRequests/inputResponses/requestState and form/URL/established interrupt translations remain permanent supported wire behavior. Origins/hashes/records stay private. Result methods remain optional. PASS.                                                                                                   |
| E demand / mcp_audit_demand       | Disconfirmation: unchanged graph/client consumers; SDK kill condition satisfied; legacy client proves compatibility; packed Skein question and tool-review workflows added with final-result/single-resume criteria. Non-goals constrain infrastructure/policy. PASS.                                                                                                                              |
| F parity / mcp_audit_parity       | Obligations: memory/SQLite/Postgres, absent/partial result methods, all adapters/routers, packed protocol-only consumer, Node/Bun/Deno serving including interrupted MCP, cancellation/disposal, revocation/deletion races. Preserve inline execution, peer floors and thread retention. PASS; implementation validation remains required.                                                         |

Considered and rejected by the independent auditors: custom handler composition makes maintained
protocol support downstream (A); generic interrupt/resume already completes elicitation (A);
NativeClient.resume supplies inline execution (A); MCPAdapter hosts graph servers (B); state signing
replaces durable one-winner/erasure semantics (B); caller binding chooses graph ownership policy (C);
transport caps approve/reject graph questions (C); private kwargs require driver expansion (D);
absence of a new plugin interface needs a second implementation (D/E); SDK-only proof establishes
Skein end-to-end behavior (E, rejected as a claim and costed as acceptance); new storage migrations
are necessary (F); modern serving needs global or Node-only transport (F).

Advisories incorporated: public fromJsonSchema reuse, explicit packed adopter workflow,
private origins, exact resultType wording, legacy JSON composition, optional capability pairs,
MCP runtime cases, late-record/erasure races, and request-scoped SDK disposal. Expiration makes
a continuation unusable; housekeeping can erase it later. Neither action automatically approves,
rejects, or resumes the graph.
