# Documentation adoption audit — 2 November 2026

Contributor record for the adoption-focused documentation revision. Apply the canonical
[documentation rule](../../AGENTS.md#documentation-teach-adoption-and-use): readers should be able to
choose a capability, use it in their project, and verify the result. Real-world examples explain
why a step matters; the deterministic echo graph remains the first setup check.

**Keep** means the existing page already teaches an adopter's task. **Rewrite** includes targeted
corrections and new task guides. **Move detail** means public usage contracts remain while repository
implementation or validation narratives move to contributor material. This inventory is not an
implementation specification for new runtime behavior.

## Public page inventory

| Page                                                                      | Decision    | Reader-focused reason                                                                                               |
| ------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| [adapters.md](../adapters.md)                                             | Rewrite     | Keep mounting contracts; replace a CI-only aside with the supported Fetch build path.                               |
| [agent-protocol.md](../agent-protocol.md)                                 | Rewrite     | Retain wire contracts and limits; remove test-gate commentary.                                                      |
| [agent-skills.md](../agent-skills.md)                                     | Keep        | Already explains when to install guidance and how to use it in the adopter's project.                               |
| [assistants.md](../assistants.md)                                         | Keep        | Task examples cover configuration, version rollback, schema inspection, and deletion effects.                       |
| [background-jobs.md](../background-jobs.md)                               | Keep        | Starts with enqueueing work and receiving results; retention and idempotency affect adoption.                       |
| [building-a-runner.md](../building-a-runner.md)                           | Rewrite     | Lead with the custom-agent integration task and required capabilities instead of CI machinery.                      |
| [building-an-adapter.md](../building-an-adapter.md)                       | Keep        | The request/response, SSE, auth, and lifecycle contract is needed by custom adapter authors.                        |
| [building-blocks.md](../building-blocks.md)                               | Rewrite     | Make the concept map a set of user decisions and connect inspection to the console.                                 |
| [bundling.md](../bundling.md)                                             | Move detail | Keep bundler settings and migration setup; move regression history to contributor architecture.                     |
| [channels.md](../channels.md)                                             | Rewrite     | Replace repetitive architectural rationale with real order/refund workflows and adoption choices.                   |
| [console-reference.md](../console-reference.md)                           | Rewrite     | New linked setup and advanced usage reference preserves auth, mounts, and mutation effects.                         |
| [console.md](../console.md)                                               | Rewrite     | Replace the feature catalog with run, inspect, diagnose, and retry workflows for the reader's graph.                |
| [crons.md](../crons.md)                                                   | Move detail | Keep schedule contracts and recovery effects; move ticker/outbox implementation details.                            |
| [deploy-aws.md](../deploy-aws.md)                                         | Keep        | Platform setup ends in verification and retains CPU, networking, and shutdown constraints.                          |
| [deploy-cloud-run.md](../deploy-cloud-run.md)                             | Keep        | Deployment steps and verification explain always-allocated CPU and streaming requirements.                          |
| [deploy-fly.md](../deploy-fly.md)                                         | Keep        | Runnable configuration and verification retain sleep, port, and shutdown caveats.                                   |
| [deploy-kubernetes.md](../deploy-kubernetes.md)                           | Keep        | Manifests, ingress settings, and verification teach deploying the reader's service.                                 |
| [deploy-railway.md](../deploy-railway.md)                                 | Keep        | Service setup and health verification are already task-focused.                                                     |
| [deploy-render.md](../deploy-render.md)                                   | Keep        | Setup and verification preserve instance sleep and streaming limits.                                                |
| [deploy-serverless.md](../deploy-serverless.md)                           | Keep        | Explains the deployment choice and a viable frontend/long-lived-backend arrangement.                                |
| [deploy-vps.md](../deploy-vps.md)                                         | Keep        | Docker, Compose, service management, and verification are already actionable.                                       |
| [deploy.md](../deploy.md)                                                 | Rewrite     | Keep deployment verification and operational limits; replace internal image-gate narration with application checks. |
| [embedding.md](../embedding.md)                                           | Rewrite     | Add expected-output verification, an SDK test path, and an explicit manual-console mount link.                      |
| [errors-and-logging.md](../errors-and-logging.md)                         | Rewrite     | Start diagnosis with a real failed order request and finding its existing run.                                      |
| [features.md](../features.md)                                             | Rewrite     | Correct shipped MCP status and express scale/runtime choices in user terms.                                         |
| [getting-started.md](../getting-started.md)                               | Rewrite     | Add a known-result verification step and separate CLI console access from manual embedding.                         |
| [human-in-the-loop.md](../human-in-the-loop.md)                           | Rewrite     | Use current Waiting for you labels and describe testing the resumed run.                                            |
| [index.md](../index.md)                                                   | Rewrite     | Link the first successful console check to repeatable project tests.                                                |
| [langgraph-cli-compat.md](../langgraph-cli-compat.md)                     | Move detail | Replace implementation-tool inventory with a migration verification path.                                           |
| [langgraph-compatibility.md](../langgraph-compatibility.md)               | Rewrite     | Lead with verified combinations and limitations, not obsolete baseline statuses.                                    |
| [langgraph-essentials.md](../langgraph-essentials.md)                     | Keep        | Graph concepts and examples help readers modify their own graph; deeper material links upstream.                    |
| [local-deployment-validation.md](../local-deployment-validation.md)       | Rewrite     | Label dated contributor evidence and remove it from the consumer LLM bundle.                                        |
| [local-deployment.md](../local-deployment.md)                             | Rewrite     | Replace packaging-gate narrative with checks for the reader's packaged application.                                 |
| [memory.md](../memory.md)                                                 | Rewrite     | Lead with remembering an aisle-seat preference and isolating support conversations.                                 |
| [native-access-security.md](../native-access-security.md)                 | Rewrite     | Keep security decisions and limits; move dated dependency review out of the adoption path.                          |
| [native-access-validation.md](../native-access-validation.md)             | Rewrite     | Label historical contributor validation and retain moved dependency-review evidence.                                |
| [native-access.md](../native-access.md)                                   | Rewrite     | Preserve custom driver contracts; replace test-target narrative with integration verification.                      |
| [observability.md](../observability.md)                                   | Keep        | Configuration, backend choices, costs, and custom sink contracts support operating a project.                       |
| [performance.md](../performance.md)                                       | Move detail | Keep tuning controls and application measurements; move repository benchmarks and historical timing.                |
| [profiling.md](../profiling.md)                                           | Rewrite     | Profile the installed application; keep repository fixtures in contributor guidance.                                |
| [react-sdk.md](../react-sdk.md)                                           | Rewrite     | Install, connect, send, display, stop, and handle approval/error before compatibility reference.                    |
| [authentication.md](../recipes/authentication.md)                         | Keep        | Provider integration, ownership policy, cookies, and CORS are public usage requirements.                            |
| [coupled-channel.md](../recipes/coupled-channel.md)                       | Keep        | A concrete WhatsApp workflow teaches the smaller same-provider integration.                                         |
| [decoupled-channel-delivery.md](../recipes/decoupled-channel-delivery.md) | Keep        | A refund approval example teaches source/destination routing and the allowlist.                                     |
| [deep-agents.md](../recipes/deep-agents.md)                               | Keep        | Experimental status, concrete integration, and dependency caveats guide adoption.                                   |
| [index.md](../recipes/index.md)                                           | Rewrite     | Lead with selecting a task and comparing a runnable example, not test provenance.                                   |
| [memory.md](../recipes/memory.md)                                         | Keep        | Short examples use public store, search, and retention APIs.                                                        |
| [production.md](../recipes/production.md)                                 | Keep        | Public auth, durability, delivery, deployment, and monitoring steps are already task-focused.                       |
| [running-agents.md](../recipes/running-agents.md)                         | Keep        | Small recipes show background runs, schedule, retry keys, resume, and replay.                                       |
| [serving.md](../recipes/serving.md)                                       | Keep        | Adapter choice and CORS examples teach connecting an application.                                                   |
| [roadmap.md](../roadmap.md)                                               | Rewrite     | Describe current capabilities and remaining limits without implementation-phase history.                            |
| [runs-and-redis.md](../runs-and-redis.md)                                 | Rewrite     | Lead with queue choice, recovery, inspection, and concurrency instead of engine internals.                          |
| [runs.md](../runs.md)                                                     | Rewrite     | Keep run contracts and clarify legacy versus dedicated frontend disconnect behavior.                                |
| [scaffolding.md](../scaffolding.md)                                       | Rewrite     | Add echo/test verification and move repository distribution and publication details.                                |
| [serving-a-single-graph.md](../serving-a-single-graph.md)                 | Keep        | A complete endpoint example explains when threads/runs are unnecessary.                                             |
| [state-and-context.md](../state-and-context.md)                           | Rewrite     | Keep the four-input guide; describe metadata as labels rather than promising it is unreadable.                      |
| [storage.md](../storage.md)                                               | Rewrite     | Choose, configure, and verify persistence before the precise driver/interface reference.                            |
| [streaming.md](../streaming.md)                                           | Rewrite     | Retain protocol contracts and restoration behavior; remove an internal cursor detail.                               |
| [testing-your-project.md](../testing-your-project.md)                     | Rewrite     | New graph assertions, opt-in SDK smoke test with cleanup, and conditional durability/resume checks.                 |
| [threads.md](../threads.md)                                               | Rewrite     | Describe checkpoint storage honestly while retaining the existing task-oriented API guide.                          |
| [using-skein.md](../using-skein.md)                                       | Rewrite     | Retain the public API cheat sheet; distinguish adapter config loading from CLI reload/snapshots.                    |
| [webhooks.md](../webhooks.md)                                             | Keep        | Receiver signing, deduplication, retries, replay, and retention are necessary delivery contracts.                   |
| [why.md](../why.md)                                                       | Rewrite     | Replace long competitive/implementation arguments with relatable fit, ownership, and adoption choices.              |
| [your-first-agent.md](../your-first-agent.md)                             | Rewrite     | Preserve the successful echo walkthrough and teach running its generated tests.                                     |

## Contributor and historical material

| Source                                                                                      | Decision    | Reason                                                                        |
| ------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| [audits/dependency-advisories-2026-10-20.md](../audits/dependency-advisories-2026-10-20.md) | Keep        | Contributor or historical material; retained separately from adoption guides. |
| [code-practices.md](../code-practices.md)                                                   | Keep        | Contributor or historical material; retained separately from adoption guides. |
| [proposals/README.md](../proposals/README.md)                                               | Keep        | Contributor or historical material; retained separately from adoption guides. |
| [proposals/a2a-run-results.md](../proposals/a2a-run-results.md)                             | Keep        | Contributor or historical material; retained separately from adoption guides. |
| [reuse.md](../reuse.md)                                                                     | Move detail | Contributor or historical material; retained separately from adoption guides. |
| [testing.md](../testing.md)                                                                 | Move detail | Contributor or historical material; retained separately from adoption guides. |

Historical validation pages keep their existing URLs, receive explicit contributor labels, and stay
out of the consumer LLM bundle. The new inventory stays outside the published site. Draft proposals
remain drafts; they do not establish shipped capability.

## Other adoption surfaces

| Source                                                                                                    | Decision    | Reason                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| [Root README](../../README.md)                                                                            | Rewrite     | Link graph testing, console setup reference, and automated project tests.                        |
| [Console package README](../../packages/console/README.md)                                                | Move detail | Preserve install/mount/API usage and link contributor implementation notes.                      |
| [Installable skein-js skill](../../skills/skein-js/SKILL.md)                                              | Rewrite     | Teach agents to explain the adopter's task and verify it with the new guides.                    |
| [Nx skill](../../skills/skein-js-nx/SKILL.md) and [Turbo skill](../../skills/skein-js-turborepo/SKILL.md) | Keep        | Existing workspace instructions preserve user tooling and verify the generated application.      |
| Scaffold README templates                                                                                 | Keep        | Already include public setup, checks, and deployment; this revision changes no generated output. |

Package READMEs remain focused references for their public package or explicit contributor material
for private packages. The following inventory records the secondary surface checked for duplicated
onboarding; package-specific API contracts are retained.

| Package README                                                      | Decision | Reason                                                                         |
| ------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| [agent-protocol](../../packages/agent-protocol/README.md)           | Rewrite  | Align testing links and compatibility/adoption wording with the public guides. |
| [bench](../../packages/bench/README.md)                             | Keep     | Retain package-specific installation, API, and host requirements.              |
| [bullmq](../../packages/bullmq/README.md)                           | Keep     | Retain package-specific installation, API, and host requirements.              |
| [channels](../../packages/channels/README.md)                       | Keep     | Retain package-specific installation, API, and host requirements.              |
| [cli](../../packages/cli/README.md)                                 | Rewrite  | Align testing links and compatibility/adoption wording with the public guides. |
| [config](../../packages/config/README.md)                           | Keep     | Retain package-specific installation, API, and host requirements.              |
| [core](../../packages/core/README.md)                               | Keep     | Retain package-specific installation, API, and host requirements.              |
| [create-skein-js](../../packages/create-skein-js/README.md)         | Rewrite  | Align testing links and compatibility/adoption wording with the public guides. |
| [langgraph](../../packages/langgraph/README.md)                     | Keep     | Retain package-specific installation, API, and host requirements.              |
| [local](../../packages/local/README.md)                             | Keep     | Retain package-specific installation, API, and host requirements.              |
| [nx](../../packages/nx/README.md)                                   | Keep     | Retain package-specific installation, API, and host requirements.              |
| [runtime](../../packages/runtime/README.md)                         | Keep     | Retain package-specific installation, API, and host requirements.              |
| [runtime-redis](../../packages/runtime-redis/README.md)             | Keep     | Retain package-specific installation, API, and host requirements.              |
| [scaffold](../../packages/scaffold/README.md)                       | Keep     | Retain package-specific installation, API, and host requirements.              |
| [server-express](../../packages/server-express/README.md)           | Keep     | Retain package-specific installation, API, and host requirements.              |
| [server-fastify](../../packages/server-fastify/README.md)           | Keep     | Retain package-specific installation, API, and host requirements.              |
| [server-fetch](../../packages/server-fetch/README.md)               | Keep     | Retain package-specific installation, API, and host requirements.              |
| [server-kit](../../packages/server-kit/README.md)                   | Rewrite  | Distinguish config loading from host-managed reload and snapshots.             |
| [server-nestjs](../../packages/server-nestjs/README.md)             | Keep     | Retain package-specific installation, API, and host requirements.              |
| [server-nextjs](../../packages/server-nextjs/README.md)             | Keep     | Retain package-specific installation, API, and host requirements.              |
| [storage-memory](../../packages/storage-memory/README.md)           | Keep     | Retain package-specific installation, API, and host requirements.              |
| [storage-postgres](../../packages/storage-postgres/README.md)       | Keep     | Retain package-specific installation, API, and host requirements.              |
| [storage-sqlite](../../packages/storage-sqlite/README.md)           | Keep     | Retain package-specific installation, API, and host requirements.              |
| [telemetry-langsmith](../../packages/telemetry-langsmith/README.md) | Keep     | Retain package-specific installation, API, and host requirements.              |
| [telemetry-otel](../../packages/telemetry-otel/README.md)           | Keep     | Retain package-specific installation, API, and host requirements.              |
| [telemetry-posthog](../../packages/telemetry-posthog/README.md)     | Keep     | Retain package-specific installation, API, and host requirements.              |
| [test-support](../../packages/test-support/README.md)               | Keep     | Retain package-specific installation, API, and host requirements.              |

## Verification obligations

Check Nx formatting, docs build/SEO, new HTML/Markdown pages, and rendered affected anchors. Exercise
the literal graph and SDK test snippets in a disposable application, including skipped versus enabled
smoke-test behavior. Inspect desktop/narrow and light/dark navigation. Preserve existing URLs and
linked fragments, notably `console#mounting-it-yourself`. No runtime, API, or scaffold change is
required by this audit.

## Validation record

- Disposable project: the literal graph tests and React/SDK examples type-check; two graph assertions
  pass without a server and the smoke test skips without its opt-in URL.
- Real local CLI server: the enabled SDK smoke test passes, saved state matches the result, and the
  created thread is deleted. The CLI console mount responds successfully.
- Rendered review: desktop and 390px phone layouts in light and dark themes; mobile navigation reaches
  the testing guide and the document has no page-level horizontal overflow.
- Link audit: preserve all former heading anchors on revised pages, add aliases for existing mismatched
  inbound fragments, replace the sidebar's missing proposal destination, and use GitHub links for
  excluded contributor pages. The initial rewrite check preserved 431 former heading anchors and resolved all
  976 rendered fragment links.

Nx docs build/SEO (67 pages), docs lint, changed-file formatting, and `git diff --check` pass.

The disposable fixture uses local built skein-js packages and installed dependencies; it is not a
fresh registry-install or packed-release validation. No live provider, production data, runtime
source, or scaffold output is changed by these checks.

## Commit review corrections

The follow-up review qualifies restart checks for durable storage, restores the draft/identity
caveat, fixes the scaffold's Assistant ID and model-install dependencies, and distinguishes config
loading from CLI reload/snapshots. Public custom-driver contracts remain; storage implementation
history moves to the contributor reuse guide. The storage reference links the memory guide
instead of repeating incomplete code, and explains TTL outcomes without scheduler implementation
detail. The memory examples use current middleware options, describe their actual merge rule, and
distinguish a delayed extraction from debouncing. The commit gate also runs the full workspace checks
and Docker-backed integration suite rather than relying only on the earlier documentation checks.
