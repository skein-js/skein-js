---
name: audit-plan
description: Audit a design plan or proposal before any of it is built — decide for each capability whether it is the library's problem or the user's, and if the user's, whether they have the primitives to solve it; enumerate the permanent public surface it would add; verify every load-bearing claim against the real codebase instead of assuming it; and fan out independent per-dimension auditors so a plan is never marked by its own author. Returns a blocking verdict: findings that shrink scope, build a feature where a primitive would do, reinvent a `@langchain/*` capability, encode a policy belonging to the deployment, or commit public API the project cannot later withdraw stop the plan until it is revised or the user explicitly confirms an override, which is recorded in the repo. Use whenever a plan-mode plan or a `docs/proposals/*.md` is about to be approved, implemented, or turned into commits. Enforces AGENTS.md golden rule 1 ("reuse first") at design time, the way `/commit` enforces rule 4 at commit time.
---

# /audit-plan — gated design review

skein is published, open source, and used by people who are not in the conversation that produced
the plan. This audit represents them. Run it, revise anything blocking, re-run, **then** build. It is
the design-time counterpart to [`/commit`](../commit/SKILL.md): rule 4 keeps red code out of the
repo, this keeps unearned scope and unearned API out of the plan, enforcing
[AGENTS.md](../../../AGENTS.md) golden rule 1 and [docs/reuse.md](../../../docs/reuse.md).

**Public API here is effectively permanent, and that is the stake.** `nx release` versions every
`packages/*` as a _fixed_ group ([nx.json](../../../nx.json)), so one breaking change majors packages
that did not change. The repo's own policy is to rename by alias and `@deprecated`, never by removal —
and it has honoured that, carrying five live aliases in `packages/*/src` rather than deleting a name.
So an exported symbol, config key, route or wire field is not a decision that gets revisited later;
it is maintenance surface for as long as the project exists. The question is not "is this a good
idea?" but **"are we sure enough to keep it forever?"**

**The second question is whose problem it is.** skein's value is plumbing users cannot write
themselves. For anything else, the library's job is to make sure the primitives exist and then get
out of the way — a primitive is smaller permanent surface than a feature, and it fits deployments
whose requirements we will never see. Both standards are empirical, not invented: a `store.scope`
setting was built and deleted because a handler expresses every policy a setting expresses one of,
and a plan claimed background extraction was server-only when `after_seconds` plus run-cancel already
made it user-buildable. **The burden is on the plan** — an auditor that agrees with it still hands in
the rollability table, because the table is the work and agreement is not.

Two things this is not. It does not review whether the plan is _correct_ — that is code review, once
there is code. And it is not a vote: findings come from artifacts, never from a show of hands.

## 1. Resolve the target

In order: an explicit argument; else the harness's active plan file, if it keeps one (Claude Code
writes them to `~/.claude/plans/`); else a named `docs/proposals/*.md`; else the plan just discussed
in conversation — in which case restate it and put the restatement at the top of the report, so the
user can confirm the right thing was audited. If two candidates are plausible, ask rather than
guessing.

Then apply the **scope test**, which exists to let the audit be small: if the target adds no public
surface, no config key and no new user-facing capability — a refactor, a bugfix, a docs change — run
only dimensions D and F and say so in the report. An auditor with a mandate and nothing to find
invents things, so give it permission to have little to do.

## 2. Extract the inventory and the claim ledger

Two flat lists, quoted verbatim from the target, with all rationale stripped:

- **Capability inventory** — each thing the plan proposes to build, one bullet each.
- **Claim ledger** — every falsifiable assertion about this codebase, about `@langchain/*`, or about
  a provider. "LangGraph has no X", "a user cannot do Y today", "this write is atomic".

Strip the rationale deliberately: an auditor handed the argument for a capability audits the
argument instead of the capability.

## 3. Verify the premises

One subagent, run before the others because its output is their input. Rank the ledger by
load-bearingness — a claim is load-bearing if a phase disappears when it turns out false — take the
top ~10, and probe each with a command whose output is quoted back. Return a fact sheet of
`CONFIRMED` / `FALSIFIED` / `UNVERIFIABLE`, each with its probe.

Use a subagent rather than doing this yourself: when you wrote the plan, you also wrote the premises.

| Claim                          | Probe                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "LangGraph/LangChain has no X" | `ls node_modules/@langchain/`, read the installed `.d.ts`, cite the version from `pnpm-lock.yaml`                                                          |
| "a user cannot do X today"     | the export in `packages/*/src/index.ts`, the route in `packages/agent-protocol/src/http/routes.ts`, or the key in `packages/config/src/langgraph-json.ts`  |
| "this is atomic / safe"        | the actual driver method — `CronRepo.claimAndCreateRun` is the only cross-repo atomic operation, and `#withTransaction` is private to `PostgresSkeinStore` |

## 4. Fan out the auditors

Six subagents in parallel — the whole audit is one verifier then these six, and it should not be
decomposed further. Six plus the serial verifier sits inside the usual per-session concurrency cap
(Codex defaults to 8 via `agents.max_concurrent_threads_per_session`), so the fan-out runs in one
wave rather than queueing.

Each gets the fact sheet plus its own evidence base, and each returns a required **artifact** first,
then findings, then a required `considered-and-rejected` list of at least two counter-cases it
examined and dismissed. The artifact is what makes a clean pass a justification rather than an
assertion.

| #   | Dimension                        | Required artifact                                                                        | Evidence base                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **Ownership and rollability**    | **The rollability table** (below)                                                        | `packages/core/src/index.ts` and `packages/agent-protocol/src/index.ts` (one public surface per package, so these _are_ the API), `http/routes.ts`, `langgraph-json.ts`, `docs/using-skein.md`, `docs/agent-protocol.md`, `docs/recipes/`, and `examples/triage-agent` as the repo's own proof of what assembles from primitives                                                                                      |
| B   | Prior art, upstream and internal | The searched-for list: packages opened, symbols considered and rejected                  | [docs/reuse.md](../../../docs/reuse.md)'s reused-vs-rebuilt table, `grep -rn "@langchain/" packages/*/package.json`, the installed `.d.ts` files, and `packages/*/src/index.ts` for a verb we already ship                                                                                                                                                                                                            |
| C   | Policy and seams                 | The policy ledger: every config key and default, and whether a seam expresses it instead | `packages/core/src/auth/auth.ts`, `packages/agent-protocol/src/auth/route-authz.ts`, and the three proven `path:export` seams in `langgraph-json.ts` (`auth.path`, `store.adapter`, telemetry `paths`)                                                                                                                                                                                                                |
| D   | **Surface and permanence**       | **The surface ledger** (below)                                                           | `packages/*/src/index.ts` for what is already exported; the five `@deprecated` aliases in `packages/*/src` as the precedent for what removal actually costs; `packages/test-support/src/package-exports.test.ts`; AGENTS.md Conventions and [docs/code-practices.md](../../../docs/code-practices.md)                                                                                                                 |
| E   | Demand and disconfirmation       | The disconfirmation checklist                                                            | [docs/proposals/README.md](../../../docs/proposals/README.md) and `inbound-events.md` as the worked exemplar: a named workflow, success criteria measured _in user code outside this repo_, specific non-goals, genuinely open questions, and a phase 1 that can kill the plan                                                                                                                                        |
| F   | Blast radius and parity          | The obligations list, against the plan's phasing                                         | A new `SkeinStore` resource → both drivers plus `packages/test-support/src/conformance.ts` plus `*.integration.test.ts`; new HTTP behaviour → all five `packages/server-*` adapters plus `server-kit` plus the runtime matrix in `ci.yml`; a Postgres schema change → the compiled-in asset path ([docs/bundling.md](../../../docs/bundling.md)); a new third-party-implemented interface → its own conformance suite |

### The rollability table (A) — two questions, in order

Every capability gets both, and the second is the one that produces the actual deliverable:

1. **Whose problem is this — the library's or the user's?** The library's only if it is plumbing a
   user cannot write themselves: durable persistence, the queue, the adapters, the protocol, the CLI.
   Anything a deployment could assemble inside its own graph or handler is the user's.
2. **If it is the user's — can they actually solve it today?** Do the primitives exist? Then the
   answer is not "no". It is either "yes, and here is the recipe" or **"no, and here is the one
   primitive that's missing"** — and that primitive, scoped as narrowly as it can be, is what the
   plan should build instead of the feature.

Brief A constructively — _"write the user code that does this today, against the shipped API, and
stop at the exact line where you can't"_ — because a yes/no question invites assent while a
construction task has a verifiable output, and because the line where it stops **is** the missing
primitive. Cite `packages/agent-protocol/src/runs/after-seconds.test.ts` in the brief: it is the file
that would have falsified the "server-only" claim.

| Column            |                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability        | verbatim from the inventory                                                                                                                                             |
| Whose problem     | library · user                                                                                                                                                          |
| Solvable today    | yes · no · partly                                                                                                                                                       |
| With what         | the real exports, endpoints or config that do it                                                                                                                        |
| Missing primitive | the narrowest thing that would close the gap, or —                                                                                                                      |
| Verified by       | `file:line`, or a test that demonstrates it                                                                                                                             |
| Verdict           | `already possible` (ship a recipe, not code) · `needs a primitive` (build the named primitive) · `library's own` (build it) · `ergonomics` (say so plainly, then defer) |

### The surface ledger (D)

Every permanent thing the plan would add — each exported symbol, config key, HTTP route, header,
wire field, and interface method — one row each, with:

- **Could it be internal?** Not exported at all. The default answer is yes until the plan names an
  external caller.
- **Could it be narrower?** A function instead of an interface; one concrete implementation instead
  of a plugin seam; an optional method instead of a required one. Widening later is additive and
  cheap; narrowing later is a break the fixed release group charges to every package.
- **What would withdrawing it cost?** Given alias-and-never-remove, the honest answer is usually "we
  keep it forever" — say that plainly rather than implying it can be walked back.
- **What proves the shape is right?** A second consumer, an example, an issue. A seam with one
  implementation is a guess with an interface around it.

Check names here too, against AGENTS.md Conventions — the `data`/`info`/`util`/`handle`/`manager`/
`process` ban list, verb-first functions, noun values, named exports, kebab-case, layout by feature —
plus Zod at boundaries and config keys under the reserved `skein.*` namespace. A name is part of the
permanent surface; getting it wrong costs an alias forever.

### Isolation

**Withhold, from every auditor:** the conversation that produced the plan, your own view or draft
verdict, and any other auditor's findings. Anchoring on the author's reasoning is the whole thing
this fan-out exists to prevent. Give A, B and C only the stripped inventory; D, E and F get the full
document, because they judge whole-document properties.

Cap each dimension at 3 blocking and 5 advisory findings, and never tell an auditor how many to
find. Caps force ranking; quotas manufacture findings.

## 5. Re-verify every finding

Re-open each cited file and confirm the excerpt exists verbatim; re-run each cited command. Anything
that does not check out is **dropped, not downgraded** — a fabricated citation is not a weak finding.
Evidence of absence is admissible only with the exact command and its empty output shown.

## 6. Classify

Aggregate, dedupe and delete. Do not author a finding, do not soften one, and do not re-severity
except by the closed list below — that is what stops a plan's author from grading it.

Three gates, all required before anything may block: the evidence is a **citation, not a judgement**;
the confidence is **verified, not inferred** (inferred caps at advisory); and it names the **clearing
edit** — if an auditor cannot say what change removes the finding, it does not understand it well
enough to block on it.

|     | Blocks when                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | A capability is already solvable with the shipped public API and the plan does not say so — the deliverable was a recipe                                                                             |
| B2  | **The plan builds a feature where a primitive would do** — the table says the problem is the user's and names the missing primitive, and the plan builds past it. The clearing edit is the primitive |
| B3  | A capability is framed as capability but the table shows it is ergonomics                                                                                                                            |
| B4  | Reinvention of a `@langchain/*` export, or of one skein already ships                                                                                                                                |
| B5  | Policy in the server — a config key or hardcoded default decides ownership, permission, identity→storage mapping, or routing authority where a handler could express it                              |
| B6  | A load-bearing premise is false                                                                                                                                                                      |
| B7  | **Unjustified public surface** — an export, config key, route or wire field the ledger shows could be internal, narrower, or deferred                                                                |
| B8  | **Irreversible by construction** — a required method on an interface third parties implement, or an incompatible change to an existing public type, with no additive or optional path                |
| B9  | **Shape unproven** — a plugin seam, interface or extension point advertised with one implementation and no second consumer, example, or issue proving the shape                                      |
| B10 | Missing non-goals or kill condition, on a plan proposing new public surface                                                                                                                          |
| B11 | An uncosted parity obligation — a store resource without both drivers and conformance, or HTTP behaviour without all five adapters                                                                   |

Everything else is advisory, explicitly including phase ordering, doc placement, "this feels large",
and any performance claim not anchored to `packages/bench`. Naming is advisory _unless_ the name
violates a stated Convention, in which case it is B7 — the permanent surface is exactly where style
stops being style. Reject these finding shapes outright, in either severity: _seems over-engineered_,
_consider whether_, _may be brittle_, _could be confusing_.

## 7. Block, confirm, record

Any blocking finding means the verdict is `BLOCKED`. Stop there — do not start implementing, and do
not restate the verdict more softly than the rules give it.

An override is the user's decision alone. Ask for it explicitly — a direct question naming the
specific findings being waived — and take only an affirmative answer with a reason; silence, "ok", or
the conversation moving on is not an override. On confirmation, append an entry to
[`.agents/audit-overrides.md`](../../audit-overrides.md) — date, target, each waived rule id with a
one-line claim, and the user's reason in their own words — and say in the report that it was
recorded. Never record an override that was not explicitly confirmed, and never proceed past a
blocking finding without one.

## 8. Report

In this order, because the most decision-relevant thing goes first and a pass has to be earned:

1. Verdict and target, plus a note if the plan was authored in this same session.
2. **The scope delta and the surface delta, one line each** — "proposes 9 capabilities; 3 are the
   library's, 4 need one named primitive, 2 are already possible" and "adds 6 permanent public
   symbols; 2 survive the ledger". Those are the headline, not a footnote.
3. The rollability table and the surface ledger in full — on a pass as well as a block.
4. Blocking findings, ranked by how much scope or permanent surface the clearing edit removes.
5. Advisories.
6. Premises confirmed and falsified, with the probe used for each. Falsified ones get their own
   heading; historically those are the ones that shipped.

A `PASS` must be justified, not asserted: it requires a non-empty rollability table, surface ledger,
searched-for list and obligations list, plus the strongest counter-case each dimension considered and
why it failed. "No findings" is never a pass on its own.
