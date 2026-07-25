# Bundling skein

Most people never read this page: if you deploy the `skein build` image, or run `next start` with
skein mounted as a route handler, bundling is already handled. You need this page when **you** own
the bundler — an rspack/webpack server build, an esbuild bundle for Lambda, a Next.js app with an
unusual config — and skein is inside its module graph.

The short version: **skein is ESM-only, and everything except the CLI bundles cleanly.** Two packages
must stay external, and only if you use the `langgraph.json` on-ramp.

## Contents

- [skein is ESM-only](#skein-is-esm-only)
- [What must stay external](#what-must-stay-external)
- [Copy-paste configs](#copy-paste-configs)
- [The "Critical dependency" warning](#the-critical-dependency-warning)
- [Postgres migrations are compiled in](#postgres-migrations-are-compiled-in)

## skein is ESM-only

Every `@skein-js/*` package is `"type": "module"` and ships a single ESM entry. There is no CommonJS
build and there won't be one.

That does **not** mean you can't `require()` it. Each library package exposes a `default` export
condition, so Node's `require(esm)` resolves it:

```js
const { embedPostgresGraphs } = require("@skein-js/runtime"); // works on Node 20.19+ / 22.12+
```

`require(esm)` landed unflagged in **Node 20.19** and **22.12**. On an older Node you get
`ERR_REQUIRE_ESM` telling you to use `import()` instead — which is the honest answer, and what a
CJS-emitting bundler should be configured to do. Plain `import` works on any Node ≥ 20.

> Before 0.10.0 the packages declared only `types` + `import` conditions, so `require()` failed with
> `ERR_PACKAGE_PATH_NOT_EXPORTED` — which reads like the package is broken rather than like a module
> format mismatch. If you're pinned below 0.10.0, that's the fix.
>
> The `skein-js` CLI keeps the old shape deliberately: it has no exports, and its entry point runs a
> command as a side effect. `require()`-ing it should fail.

**`require()` does not tree-shake.** `require("@skein-js/runtime")` eagerly loads
`@skein-js/config` and therefore `@langchain/langgraph-api`, even if you only use
`embedPostgresGraphs` and never touch a `langgraph.json`. It works, it just costs ~0.5s of cold
start. Prefer `import` where your toolchain allows it.

## What must stay external

| Package                    | Bundle it?                | Why                                                                                     |
| -------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `@langchain/langgraph-api` | **No** — mark external    | skein's graph loader `import()`s a path computed at runtime; no bundler can follow that |
| `@typescript/vfs`          | **No** — mark external    | pulled in by the same loader                                                            |
| `skein-js` (the CLI)       | **Never**                 | a `bin` with no exports and top-level await; importing it runs a command                |
| every other `@skein-js/*`  | **Yes** — bundles cleanly | including `@skein-js/storage-postgres` as of 0.10.0                                     |

The first two only matter if you point skein at a `langgraph.json` (`buildRuntime`, the CLI, the
`{ config }` form of any adapter). If you embed graphs in code — `embedPostgresGraphs`,
`embedInMemoryGraphs`, the `{ deps }` form — the graph loader is never reached and a bundler that
tree-shakes will drop it for you.

## Copy-paste configs

**Next.js** (`next.config.mjs`):

```js
export default {
  serverExternalPackages: ["@langchain/langgraph-api", "@typescript/vfs"],
};
```

**webpack / rspack** (server build):

```js
export default {
  target: "node",
  externals: [
    { "@langchain/langgraph-api": "commonjs @langchain/langgraph-api" },
    { "@typescript/vfs": "commonjs @typescript/vfs" },
  ],
};
```

**esbuild**:

```bash
esbuild server.ts --bundle --platform=node --format=esm \
  --external:@langchain/langgraph-api --external:@typescript/vfs
```

Prefer `--format=esm` if you can. With `--format=cjs`, anything the bundle `require()`s at runtime
still needs Node 20.19+, per above.

## The "Critical dependency" warning

webpack and rspack emit this when they meet skein's graph loader:

```text
Critical dependency: the request of a dependency is an expression
```

It's expected and harmless — that expression is the `import()` of your graph module, resolved from
`langgraph.json` at runtime. Externalizing `@langchain/langgraph-api` removes most of it; to silence
the rest:

```js
// next.config.mjs
export default {
  serverExternalPackages: ["@langchain/langgraph-api", "@typescript/vfs"],
  webpack: (config) => {
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { message: /Critical dependency: the request of a dependency is an expression/ },
    ];
    return config;
  },
};
```

## Postgres migrations are compiled in

`@skein-js/storage-postgres` needs **no skein-side externals**. Its schema migrations ship as string
constants inside `dist/index.js`, so the package makes no filesystem access at runtime — it imports
only `node:crypto`, `pg`, and `@skein-js/core`. (`pg` itself has one wrinkle — see below.)

Before 0.10.0 it located its `migrations/` directory with `new URL("../migrations", import.meta.url)`
and handed it to `node-pg-migrate`. Bundlers rewrite `import.meta.url` to the **output** location, so
a bundled build looked fine until boot, then failed to find its own SQL against a real database. If
you hit that on an older version, externalize `@skein-js/storage-postgres` (which then has to be
present in `node_modules` at runtime) or upgrade.

Migrations still run automatically on boot, tracked in a `skein_migrations` table and serialized by a
Postgres advisory lock — see [deploy.md](./deploy.md) and [storage.md](./storage.md).

### One caveat, from `pg` rather than skein

`pg` has an optional native binding it reaches for at runtime: `pg/lib/native/client.js` does
`require('pg-native')`, and `pg-native` is an optional peer that is normally not installed. pg wraps
that call in a `try`/`catch` specifically so bundlers tolerate it, and **esbuild does** — it leaves a
runtime `require` and emits nothing. **webpack and rspack are stricter** and report:

```text
Module not found: Can't resolve 'pg-native'
```

You do not want the native binding; tell the bundler to ignore it:

```js
// webpack / rspack
import webpack from "webpack";
export default {
  plugins: [new webpack.IgnorePlugin({ resourceRegExp: /^pg-native$/ })],
};
```

Next.js keeps `pg` on its built-in server-externals list, so this never surfaces there.

## See also

- [deploy.md](./deploy.md) — deploying the built image, env vars, probes, scaling
- [embedding.md](./embedding.md) — the in-code on-ramp, which avoids the graph loader entirely
- [storage.md](./storage.md) — the Postgres driver and its schema
