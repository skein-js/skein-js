# Agent Server configuration compatibility

Implementation design for #83. Preserve Skein defaults, custom dispatcher contracts, opt-in CORS,
auth-before-custom-app, server-owned identity, and channel/BullMQ outcomes. An adopter can keep an
existing compatible configuration and observe its controls, rather than silently loading unused
security settings. This does not introduce application identity policy or a new policy plugin system.

## Inventory

- Resolve top-level webhook headers, environment templates and destination restrictions.
- Enforce explicit webhook disabling on admission, sending, retries and replay.
- Forward selected configurable headers and log selected, redacted request headers.
- Disable graph UI assets independently of Console enablement.
- Diagnose unsupported middleware and checkpointer settings at startup.

## Public surface and exact behavior

Use upstream JSON names `webhooks.headers` (string map), `env_prefix` (default `LG_WEBHOOK_`) and
`url.{allowed_domains,allowed_ports,require_https,disable_loopback,max_url_length}`. Domain entries
are exact hosts or `*.` subdomain patterns; ports are integers 1–65535; length is a positive integer.
Omitted restrictions retain current behavior. Resolve <code v-pre>${{ env.NAME }}</code> only in webhook header
values; referenced names must have the configured prefix and exist. Reject invalid names/headers
without reporting secret values. No general config interpolation is added.

An explicitly empty new domain/port list denies every HTTP destination; legacy empty
`allowed_hosts` remains unrestricted. Port checks use the effective port (80/443 when omitted).
Headers, secret expansion, selectors and policies are snapshots of the active assembly: configuration
edits require restart/reassembly. Retries use that assembly's active policy, including for older rows.

Extend existing `WebhookDeliveryConfig` with optional `headers`, `disabled`, and `url` properties.
`url` contains optional `allowedDomains`, `allowedPorts`, `disableLoopback`, `maxUrlLength`; HTTPS
uses existing `requireHttps`. These are structural optional properties, not a new required interface
or named exported type. Add optional resolver options `compatible` (top-level webhook config) and
`disabled`. Old `resolveWebhooks(raw, options)` callers retain their behavior.

Resolve headers once per assembly. Merge them before existing server delivery/signature headers;
caller-supplied variants cannot replace server-owned names, including differently cased names.
Do not attach these HTTP credentials to host-minted channel/BullMQ destinations. Enforce URL
restrictions in the existing shared destination guards for initial, polling and queued attempts.
Include the pre-outbox engine fallback for custom stores without deliveries/finalizeWithDelivery;
it must apply the same restrictions and configured headers through the existing dispatcher.
Legacy `allowed_hosts` retains exact matching and empty-as-unrestricted; top-level restrictions
are an additional predicate. Never collapse disjoint predicates into an unrestricted empty list.
Loopback refusal covers literal IPv4/IPv6 and resolved loopback addresses; configured restriction
requires redirects to be refused rather than followed to an unchecked destination. Custom HTTP
dispatchers retain responsibility for their own network redirect/DNS behavior; document that limit.

Explicit `http.disable_webhooks: true` rejects new caller-supplied HTTP callbacks and replay. Existing
pending HTTP callbacks become `dead` when next processed, without dispatch, with a visible disabled reason, retained under existing expiry
rules. Re-enabling does not automatically send them; explicit authorized replay remains available.
This uses existing dead-letter semantics and avoids a new paused status or store query contract.
Server-derived channel/BullMQ outcomes remain deliverable. Absent/false preserves current behavior.

Header selectors use `http.configurable_headers` and `http.logging_headers`, each with optional
`includes`/`excludes` string arrays. Patterns use only `*`, case-insensitive; exclusions win. An
explicit selector without includes selects otherwise nonexcluded headers; no selector forwards/logs
no new headers. Forwarded values use normalized header names as configurable keys; explicit body
configurable values win, and existing server identity sanitization remains authoritative. Apply
before authorized handler dispatch/idempotency fingerprinting, only to run-creating requests and
thread commands; never mutate original requests or turn headers into authentication.

Add optional structural `ProtocolDeps.configurableHeaders` and `loggingHeaders` selectors, reused
by config-loaded and embedded consumers. Logging uses the existing injected Logger, after
authentication succeeds, and redacts authorization/cookie/API-key/token/secret headers even when
selected. This does not reorder host-owned middleware or expose custom-app resource authorization.

`http.disable_ui` gates graph asset serving in all assemblers/artifacts and does not change Console.
Only literal booleans are supported for new disable controls; invalid values fail by key name.
`http.middleware_order` absent/`auth_first` retains current order; other values fail startup with
the supported alternative. `checkpointer.backend` absent/`default` and legacy `type: default` retain
storage-selected savers; nondefault backend or path fail startup until the separately gated saver
design is earned. Preserve unrelated unknown config keys through passthrough.

## Premises and proof

### Validation-first stop gate

Before adding public properties, reproduce the migration failure in an installed-package consumer
using current public packages. Attempt the same observable control through existing exported
dispatcher and protocol-handler seams. If composition supplies it, ship compatible configuration
wiring and documentation and **omit the unnecessary public addition**. Stop the affected addition
if no consumer failure can be demonstrated, or if its implementation cannot preserve authentication,
omission defaults and existing consumers. An incompatible discovery returns to design/audit before
implementation. No open product questions remain in this design; source/version mismatches must be
recorded as unsupported boundaries, not silently interpreted as parity.

Current webhook resolution reads only `skein.webhooks`; destination restrictions and request
headers already have shared delivery seams. The listed HTTP controls have no enforcement
references. Protocol requests pass through one shared authorized/idempotent handler table. UI/app
loading is shared between memory and durable assembly. Verify these claims before implementation.

External acceptance: a config-loaded consumer verifies selected headers in a real graph with auth
on/off, credentials redacted from logging, exact/wildcard policies and disjoint restrictions,
missing secrets failing boot, disabled sends/replay, channel/BullMQ outcomes, and disabled UI with
an independently enabled Console. Run dev/artifact and all adapter paths including both Next.js
routers. Keep third-party dispatcher signatures and existing configuration tests green.
Extend `test-support:test-compatibility-consumer` for installed-package evidence and the CLI's
artifact-consumer fixtures for the same configuration; use adapter conformance for Express/Fastify/
NestJS/Next.js App and Pages/Fetch. Include ordinary adapter `{ config }` loading, reloadable dev,
durable Postgres, configured SQLite, and explicit embedding overrides. Assert named startup errors
for unsupported middleware order and checkpointer backend/path.
Cover batch bodies, legacy thread commands, protocol `params.config`, explicit body precedence and
idempotency replay fingerprints. Include near-expiry rows: replay retains original attempt/expiry
and requires an accessible run; swept deliveries cannot be recovered by re-enabling. Run the existing
runtime-conformance and production-image smoke paths; distinguish Deno's build-only image gate.

If current exported seams already provide a capability, compose them. Reject private upstream
middleware imports, new routes/store methods, and any implementation changing omission defaults.

## Design audit — passed 9 November 2026

Authored and audited in the same session. One independent premise verifier and six independent
dimension auditors reviewed this concrete design. B10 initially blocked the missing explicit stop
gate; the gate above cleared it on re-audit. No overrides were requested or recorded.

Scope delta: five compatibility capabilities remain; application identity, a policy plugin system,
custom saver loading and new delivery resources are excluded. Surface delta: optional properties
on existing exported config/dependency/resolver contracts; no new required methods, routes, named
exports or dispatcher parameters.

| Capability                             | Owner                                         | Existing construction                                           | Missing deliverable                                                | Verdict                    |
| -------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| Webhook headers/templates/URL controls | Library onboarding; deployment chooses values | `webhookDispatcher`, `DeliveryAttempt.headers`, existing guards | Compatible config mapping and immediate policy rejection           | Compose existing machinery |
| Webhook disabling/dead letters         | Library                                       | Auth denial, existing dead/replay operations                    | One consistent policy at admission and every delivery path         | Narrow optional policy     |
| Header forwarding/logging              | Library onboarding; application owns identity | Public handler/request and Logger seams                         | Configured selection before fingerprints and authenticated logging | Shared wrapper             |
| UI disabling                           | Library onboarding                            | Existing loader/compiler and separate Console configuration     | Gate serving/watch/build paths                                     | Existing compiler reuse    |
| Unsupported configuration diagnostics  | Library                                       | Passthrough parser and programmatic saver injection             | Named startup failures with supported alternatives                 | Internal validation        |

Surface ledger: compatible JSON keys are enumerated above, including every nested domain/port/header
selector key, template syntax, omission/list defaults and diagnostic behavior. Engine properties are
`WebhookDeliveryConfig.headers`, `disabled`, `url.allowedDomains`, `url.allowedPorts`,
`url.disableLoopback`, `url.maxUrlLength`, and existing `requireHttps`. Resolver options gain
`compatible`/`disabled`. `ProtocolDeps` gains optional `configurableHeaders`/`loggingHeaders`, each
with `includes`/`excludes`. Selected configurable keys and outbound header names remain user values;
server identity/signature names remain authoritative. Internal matching/redaction/resolution helpers
are not exported. These optional structural fields are permanent public surface despite adding no
named symbol; preserve their semantics under the repository's alias/deprecation policy.

Prior-art artifact: inspected installed API 1.4.2 exports/declarations (no reusable processor for
these controls), existing `resolveWebhooks`, `deliveryHeaders`, `toDeliveryRequest`, shared destination
guards, both attempt paths, the fallback dispatcher, authorized/idempotent handler assembly,
upstream UI build/watch and injected savers. No private upstream imports or duplicate delivery,
signing, compiler or checkpointer implementations survive the audit.

Policy ledger: all omission defaults, configured values and seams are specified above. Credentials
are selected only for HTTP callbacks and require deliberate destination policy; forwarded headers
are request values, not authenticated identity. They persist in run configuration and affect the
idempotency fingerprint. Logs use the existing Logger, not a new telemetry field. Policies are
restart snapshots; custom apps retain ownership of resource authorization and logging.

Obligations artifact: the acceptance matrix above costs every assembler, adapter, body generation,
outbox/fallback/host-derived path, runtime/artifact, public package boundary and existing retention
contract. No database migration or new driver method is needed by this design.

Strongest rejected countercases, one per dimension: (A) dispatcher recipes do not apply unchanged
compatible JSON or immediate policy-dead semantics; (B) installed API exports provide no reusable
processor; (C) auth-only denial cannot stop old queued callbacks; (D) structural optional properties
still incur permanence but preserve third-party implementations; (E) a consumer/prototype can stop
an unnecessary addition; (F) existing dead/replay contracts avoid a new paused status/store resource.

Premises were verified by `rg`/line probes in the named production sources. The universal reading
of shared delivery construction was falsified by the pre-outbox direct dispatcher; its acceptance
obligation is now explicit. New upstream option semantics are established by the selected official
configuration references, not by the older installed JavaScript API implementation. Remaining
advisories (empty lists/effective ports, refresh lifetime, forwarding persistence, replay bounds,
body generations, runtime evidence and ordinary config loading) are incorporated above.
