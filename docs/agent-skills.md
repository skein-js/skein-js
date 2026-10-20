# Agent skills for building with skein-js

The [Agent Skills](https://agentskills.io/specification) in this repository guide coding agents through building a LangGraph.js project with skein-js. They are optional: skein-js works without an AI coding agent or an installed skill.

| Skill                                                                                            | Use it for                                                                                         |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [`skein-js`](https://github.com/skein-js/skein-js/tree/main/skills/skein-js)                     | Scaffolding or embedding graphs in a server, desktop app, CLI, or daemon                           |
| [`skein-js-nx`](https://github.com/skein-js/skein-js/tree/main/skills/skein-js-nx)               | Nx application generator, workspace tooling, dependency inputs, and runtime-state cache boundaries |
| [`skein-js-turborepo`](https://github.com/skein-js/skein-js/tree/main/skills/skein-js-turborepo) | Turbo tasks, storage selection, build outputs, and runtime-state cache boundaries                  |

## Server or local application

The skills cover the same LangGraph execution and Agent Protocol in either deployment. Choose
SQLite explicitly for a desktop app, CLI, daemon, or one Node owner; choose Postgres/Redis for a
shared server. New projects recommend Node 24 and enable ESLint/Prettier by default; compatible
workspace pins and explicit tooling opt-outs are preserved.

The local guidance covers `--storage sqlite`, `embedSqliteGraphs`, host-owned startup/shutdown,
and persistent state after reopening. Workspace skills keep live SQLite databases and their WAL/SHM
files out of build caches while preserving the application's build artifacts. Models, tools,
credentials, and decisions to retry or resume remain application choices. Start with the
[local deployment guide](./local-deployment.md) and its Electron, Tauri, and CLI examples.

Workspace guidance covers independent configuration and tool dependency inheritance, generated
formatting, and safe child-directory generation. Nx guidance preserves dependency cache inputs and
build ordering. See [workspace tooling and caching](./scaffolding.md#workspace-tooling-and-caching).

## Find and install a skill

The skills live in this repository's `skills/` directory. With a recent [GitHub CLI that supports `gh skill`](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills), inspect and install one into your project:

```bash
gh skill preview skein-js/skein-js skein-js@main
gh skill install skein-js/skein-js skein-js@main --agent codex
```

Replace `codex` with `cursor`, `github-copilot`, or `claude-code` to install for that agent. Add `--scope user` to make it available across your projects; the default scope is the current project. Install a workspace skill the same way, substituting its name. `@main` selects the current skill even before the next skein-js release; use `@<tag>` to select a release instead. Run `gh skill update` later to get changes from this repository.

You can also copy a skill directory into your agent's project skill location. Codex, Cursor, and GitHub Copilot read `.agents/skills/<skill-name>/SKILL.md`; Claude Code reads `.claude/skills/<skill-name>/SKILL.md`. Copy the whole directory, including any supporting files. See each agent's documentation for user-wide installation paths.

Once installed, the agent sees the skill's name and description and may select it for a matching task. To select it explicitly, ask it to use the `skein-js` skill while describing the project you want. A skill checked into this repository is available to agents working **on skein-js**; installing it in your own project makes it available to agents building **with skein-js**.

Upgrading an npm package does not refresh separately installed or copied skills. Update those from
this repository too; `@main` follows current guidance, while `@<tag>` selects that release's snapshot.
