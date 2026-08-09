---
name: commit
description: Create a git commit for this repo ONLY after the full quality gate passes — format, lint, typecheck, tests, and build for everything the change touches (plus container integration tests when DB/queue code changed and Docker is up), and docs updated to match. Use whenever the user asks to commit, or before pushing/opening a PR. Enforces AGENTS.md golden rule 4 ("green before commit — never commit red").
---

# /commit — gated commit

Never commit red. Run the gate below, fix anything that fails, re-run until green, **then** commit.
This is the enforcement of [AGENTS.md](../../../AGENTS.md) golden rule 4 and mirrors CI
(`.github/workflows`), so a passing `/commit` should mean a passing CI.

A pre-commit hook ([`.githooks/pre-commit`](../../../.githooks/pre-commit), wired by `pnpm install`)
already runs the _affected_ subset (format + lint + typecheck + test) on every `git commit` as a
mechanical backstop. This skill runs the fuller **superset** — all projects, plus build and the
Docker-backed integration tests — and handles the docs check and commit message. Run it for anything
non-trivial rather than leaning on the hook alone; never `--no-verify` past a real failure.

## 1. Establish scope

- `git status --porcelain` and `git diff HEAD` — see everything changed (staged + unstaged).
- If nothing is changed, stop and say so.
- Note which packages/areas changed (drives the docs + integration-test decisions below).

## 2. Docs must match the change

If the change alters **behavior, architecture, the CLI surface, `langgraph.json` handling, storage,
or the public API of any package**, the docs must already reflect it. Check the relevant ones:

- `docs/*` (e.g. `langgraph-cli-compat.md`, `storage.md`, `runs-and-redis.md`, `agent-protocol.md`),
- the changed package's `README.md`, and the root `README.md`,
- `AGENTS.md` / the package map if you added or reshaped a package.

If a doc is stale, update it as part of this commit. If you're unsure whether a doc needs updating,
ask the user rather than committing a docs gap. Pure internal refactors with no observable change
need no doc update — say so explicitly.

## 3. Run the gate (fix + re-run until all green)

Mirror CI exactly ([`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)) so a passing
`/commit` means a passing CI. Drive everything through Nx (never bare `eslint`/`vitest`), from the
repo root:

```bash
pnpm format              # auto-fix formatting first (nx format:write)…
pnpm format:check        # …then verify clean
CI=true pnpm exec nx run-many -t lint typecheck test build --exclude='examples/*' --output-style=stream
```

Set **`CI=true`** — without it, Vitest starts in watch mode locally (non-CI TTY heuristics) and the
`test` targets hang forever instead of running once and exiting. `CI=true` forces run-once, matching
CI. If you background the gate, poll its log for `NX   Successfully ran` / `Failed tasks:`.

CI runs `run-many` over every project, so use `run-many` here too (not `affected`) — it's the
authoritative gate. **Exclude `examples/*` locally**: examples depend on live services / local `.env`
files (e.g. `examples/chat-app/.env` sets `GOOGLE_API_KEY`, so its live-Gemini test _runs_ locally and
fails on the network, whereas CI has no `.env` and skips it). CI is the backstop for examples — it runs
them in a clean env where the key-gated tests self-skip. If your change touches an example, run that
example's target directly too (`nx test example-<name>`, `nx build example-<name>`). For a quick
inner-loop pre-check you may first run `pnpm affected`, but the `run-many` above is what must pass.

**Container integration tests** (CI's second job — Testcontainers spinning up Postgres/Redis). If
Docker is running, run them; they are required when the change touches `packages/storage-postgres`,
`packages/redis`, `packages/runtime`, or any `*.integration.test.ts`:

```bash
docker info >/dev/null 2>&1 && CI=true pnpm exec nx run-many -t test-integration --output-style=stream
```

If Docker is **not** available, do not silently skip: tell the user integration tests were not run
and let them decide whether to proceed.

Do not continue to step 4 until every command above exits 0. If something fails, fix it (or, if the
failure is genuinely pre-existing and out of scope, surface it to the user) and re-run the whole gate.

## 4. Commit

- Stage the intended files (`git add …` the files this change owns — don't sweep in unrelated edits).
- Write a [Conventional Commit](https://www.conventionalcommits.org): `type(scope): summary`, e.g.
  `feat(cli): import langgraph dev state`, `fix(storage-postgres): skip orphan runs on restore`.
  Keep the subject imperative and ≤72 chars; add a body when the "why" isn't obvious from the diff.
- Commit **directly on the current branch** (this repo commits on `main` by default; only branch
  first if the user asked for a PR/branch).
- Do **not** push or open a PR unless the user asked.

## 5. Report

State the commit hash + subject, and exactly which gate commands ran (and whether integration tests
ran or were skipped for lack of Docker). If you updated docs, say which.
