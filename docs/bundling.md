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
- [What `skein build` inlines vs. externalizes](#what-skein-build-inlines-vs-externalizes)

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
`embedInMemoryGraphs`, the `{ deps }` form — nothing reaches them: `@langchain/langgraph-api` is loaded
with `await import()` at the two points that genuinely need it (analysing a graph's schema, and adapting
a user's `Auth` instance), and the in-memory runtime loader is behind a dynamic import on the `{ config }`
branch. So on an embedded path they are never in the module graph at all, rather than being present and
merely tree-shakeable.

That is asserted, not asserted-by-comment: `packages/test-support/src/static-imports.test.ts` walks each
adapter's built output — following `@skein-js/*` edges into their own `dist` — and fails if
`@langchain/langgraph-api`, `@typescript/vfs`, or `superjson` is statically reachable. The walk is
transitive because the regression it caught was: no adapter imported `@langchain/langgraph-api`, but
every adapter imported `@skein-js/server-kit`, which imported the `@skein-js/config` barrel for one error
class, and that barrel imported `@langchain/langgraph-api`.

One trade-off worth knowing: because `@langchain/langgraph-api` is now loaded on demand, a bundling
mistake around it (the `serverExternalPackages` config below) surfaces when something first asks for a
graph schema rather than at startup. The container boots and passes its probes, and
`GET /assistants/{id}/schemas` returns a 500. Bake your schemas at build time (`skein build` does) and
the path is never taken at all.

Two consequences for the public API, both of which exist to keep that graph clean:

- `SkeinConfigError` is importable from `@skein-js/config/errors` as well as the root, and internal code
  uses the subpath. The root barrel is the `langgraph.json` loader.
- `readLanggraphDevState` / `loadSnapshotIntoStore` / `describeSnapshot` live at
  `@skein-js/server-kit/dev`, not on the root barrel — they carry `superjson` and `node:fs/promises`, and
  only `skein dev` / `skein import` call them. They are deliberately **not** re-exported from the root or
  from `@skein-js/express`: a re-export is still a static import, which would undo the split.

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

## What `skein build` inlines vs. externalizes

The section above is about bundling **skein**. This one is about the bundler skein itself runs:
`skein build` compiles your graphs (plus auth, custom embed, custom telemetry sinks) into
`.skein/build`, and the split it makes there is the reason the production image is small and the
monorepo case works at all.

**Inlined into the artifact** — your own source, including anything reached through a `tsconfig`
`paths` alias or a workspace link (`@myorg/js`, the Nx/Turborepo/pnpm-workspace pattern). Those files
exist nowhere a package manager could install them from, so resolving them once on the build host is
what dissolves the "my Docker build context doesn't contain my monorepo" problem.

**Left external and pinned** — every published `node_modules` package. `skein build` records each one
at the exact version installed on the build host and writes it into the artifact's `package.json`,
which the image installs with `npm install --omit=dev`. Externalizing is not a limitation to work
around; it is load-bearing:

- **One copy of each library.** The image installs `skein-js`, which brings `@langchain/langgraph` and
  `@langchain/core`, and that runtime is what imports your graph bundle. Inline `@langchain/core` into
  the graph and there are two copies: `instanceof BaseMessage` starts failing, and config/callbacks
  propagate through a different `AsyncLocalStorage` than the one the runtime reads.
- **Native addons can't be inlined.** `pg-native`, `sharp`, `better-sqlite3` and friends are platform
  binaries; they have to be installed for the image's platform.
- **Package-relative asset reads survive.** A bundler rewrites `import.meta.url`/`__dirname` to the
  output location, which breaks packages that load workers, wasm, or data files from beside
  themselves (pdfjs, `tiktoken`, …) — the same hazard that made skein
  [compile its own SQL in](#postgres-migrations-are-compiled-in).
- **Cheaper rebuilds.** `COPY package.json` + install is a cached Docker layer; a graph edit re-ships
  only the bundle.

The one thing a bundler structurally cannot see is a package imported **by name at runtime** —
`initChatModel` doing `import("@langchain/" + provider)`, a plugin loaded from config. Those never
appear in the module graph, so declare them under `dependencies` in `langgraph.json`:

```json
{
  "graphs": { "agent": "./src/graph.ts:graph" },
  "dependencies": ["@langchain/openai"]
}
```

(skein pins the packages behind a declared `store.index.embed` provider and a declared `telemetry`
provider for you — the field is for the ones only your code knows about.)

`skein build` fails on the **host** if the artifact would ship an import it does not install, so a
missing pin is a build-time error with a package name in it rather than an `ERR_MODULE_NOT_FOUND` from
inside `docker build`.

## See also

- [deploy.md](./deploy.md) — deploying the built image, env vars, probes, scaling
- [embedding.md](./embedding.md) — the in-code on-ramp, which avoids the graph loader entirely
- [storage.md](./storage.md) — the Postgres driver and its schema
