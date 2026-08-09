# Audit overrides

A log of blocking [`/audit-plan`](./skills/audit-plan/SKILL.md) findings that were waived and built
anyway. Append-only, newest last. Nothing is ever edited out — a waived finding that turned out to be
right is the most useful entry in the file.

Entries are written by `/audit-plan` **only** after the user explicitly confirms the override and
gives a reason. Never add one by hand to clear a verdict, and never record one that was not
confirmed: an entry nobody agreed to is worse than no log at all.

This file is deliberately not under `docs/` — that directory is published to the docs site, and this
is an internal record.

## Format

```markdown
## YYYY-MM-DD — <target: plan title or docs/proposals/x.md>

- **B4** — <one-line claim of the waived finding>
- **B7** — <one-line claim of the waived finding>

**Reason (user's words):** <verbatim>
```

## Entries

## 2026-08-09 — First-party greenfield scaffolding and onboarding

- **B3** — `create-skein` and `@skein-js/nx` are permanent convenience APIs whose underlying workflows users can already assemble from existing Skein primitives.

**Reason (user's words):** Yeah, it's [ossible but not intuitive - we didnot intend to stop plugins like this, we intended features that belong downstream, this belongs upstream
