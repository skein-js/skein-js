import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Plugin } from "vite";
import type { SiteConfig } from "vitepress";

/**
 * Serving the site's LLM-facing surface: `/llms.txt`, `/llms-full.txt`, and a raw `.md` twin of
 * every page.
 *
 * Why this exists at all: the two bundles are already generated (`pnpm docs:llms`) and already
 * curated by hand, but they live at the **repo root** — so before this, nothing served them. An
 * agent pointed at the docs site got a 404 on the one path the convention says to try first, and the
 * only working copy was a raw.githubusercontent.com URL. llmstxt.org puts `llms.txt` at the site
 * root; that is the whole point of the filename.
 *
 * Why the root files are read rather than duplicated into `docs/public/`: two copies of one file is
 * the defect shape this repo pays for most. `llms.txt` is hand-written and `llms-full.txt` is
 * concatenated in a deliberate order ("Order matters — it's the narrative", per its generator), so
 * they have exactly one author each. This module copies them at build time and streams them in dev;
 * `pnpm docs:llms` stays the only thing that writes them.
 *
 * Why per-page `.md` twins are emitted rather than linking to GitHub: a deployed site and `main` are
 * not the same content, so a "view as markdown" link to raw GitHub shows a reader a different page
 * than the one they are on. Same-origin twins also need no network and no CORS, and they give an
 * agent a URL per page instead of one 636 KB bundle.
 */

/** The two bundles, at the repo root, named by the convention that makes them findable. */
const BUNDLES = ["llms.txt", "llms-full.txt"] as const;

/**
 * A page's markdown twin is served at its own route plus `.md` — `/why` → `/why.md`.
 *
 * That falls out of VitePress's own vocabulary rather than needing a mapping table: `relativePath`
 * *is* the served path (post-`rewrites`), so writing each page to `outDir/<relativePath>` puts the
 * twin exactly where the client computes it should be. `useData().page.relativePath` is the same
 * string on the client, which is why CopyPage.vue needs no knowledge of any of this.
 */
const twinPath = (servedPath: string) => servedPath;

/**
 * Frontmatter is stripped. It is site configuration — `layout: home`, a `description` override — and
 * never prose, so to a reader it is noise and to a model it is noise that looks like content.
 * `generate-llms-full.mjs` applies the same rule to the curated bundle, including page-specific SEO
 * metadata and the landing page's configuration.
 */
const stripFrontmatter = (markdown: string) => markdown.replace(/^---\r?\n.*?\r?\n---\r?\n/s, "");

/**
 * Every page on the site, as `{ sourceFile, servedPath }`.
 *
 * `siteConfig.pages` is the post-`srcExclude` file list and `siteConfig.rewrites.map` is the
 * source→served mapping, both already computed by VitePress — so the three contributor docs excluded
 * from the site get no twin, and `proposals/README.md` is served as `proposals/index.md`, without
 * this file restating either rule.
 */
const pagesOf = (siteConfig: SiteConfig) =>
  siteConfig.pages.map((page) => ({
    sourceFile: page,
    servedPath: siteConfig.rewrites.map[page] ?? page,
  }));

/**
 * Write the bundles and the twins into the built site.
 *
 * Called from `buildEnd`, which runs after the SSG output exists, so this only adds files and can
 * never race the pages themselves.
 */
export const writeLlmAssets = async (siteConfig: SiteConfig) => {
  const repoRoot = resolve(siteConfig.srcDir, "..");

  await Promise.all(
    BUNDLES.map(async (name) => {
      const source = join(repoRoot, name);
      // Absent rather than fatal: `llms-full.txt` is generated, so a fresh clone that has not run
      // `pnpm docs:llms` yet would otherwise fail the build — and the docs build is what gates the
      // Pages deploy. A missing bundle costs one dropdown entry a 404; it must not cost the deploy.
      if (!existsSync(source)) {
        console.warn(`[llm-assets] ${name} not found at the repo root — run \`pnpm docs:llms\`.`);
        return;
      }
      await copyFile(source, join(siteConfig.outDir, name));
    }),
  );

  await Promise.all(
    pagesOf(siteConfig).map(async ({ sourceFile, servedPath }) => {
      const markdown = await readFile(join(siteConfig.srcDir, sourceFile), "utf8");
      const target = join(siteConfig.outDir, twinPath(servedPath));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, stripFrontmatter(markdown));
    }),
  );
};

/**
 * The same two things, over the dev server.
 *
 * Without this the dropdown works in production and 404s under `pnpm docs:dev`, which is the shape
 * of bug nobody finds until it is deployed. Reads on request rather than copying, so editing a doc
 * changes its twin with no restart.
 */
export const llmAssetsDevPlugin = (): Plugin => ({
  name: "skein:llm-assets",
  // `pre`, so the request is answered before Vite's own static and transform middlewares try to
  // resolve a `.md` URL as a module graph entry.
  enforce: "pre",
  configureServer(server) {
    // VitePress attaches its resolved config to the Vite config (`vitepress: siteConfig`, set in its
    // own `config()` hook, which has run by the time `configureServer` does). Vite's own
    // `ResolvedConfig` type does not declare the field, hence the cast.
    const siteConfig = (server.config as unknown as { vitepress?: SiteConfig }).vitepress;
    if (!siteConfig) return;

    const repoRoot = resolve(siteConfig.srcDir, "..");
    // Served twin path → file on disk. `siteConfig.rewrites.inv` would answer the second half, but
    // this map answers both halves at once: a miss means "not a page on this site", which is what
    // keeps the three `srcExclude`d contributor docs from being readable here.
    const sourceOf = new Map(
      pagesOf(siteConfig).map(({ sourceFile, servedPath }) => [twinPath(servedPath), sourceFile]),
    );
    const base = server.config.base;

    server.middlewares.use((req, res, next) => {
      if (!req.url) return next();

      // A query string means Vite, not a reader. VitePress loads every page's *module* from that
      // page's markdown — `/why.md?import&t=…`, because a `.md` file here compiles to a Vue SFC — so
      // answering those with `text/plain` breaks strict MIME checking and the page renders as a 404.
      // Cost one round of that before the guard existed; production has no module graph, so the
      // collision is dev-only and invisible to a build.
      const [url, query] = req.url.split("?");
      if (query !== undefined) return next();

      // Vite strips `base` for some middleware positions and not others, so accept both spellings
      // rather than depending on where in the chain this lands.
      const path = decodeURIComponent(
        url.startsWith(base) ? url.slice(base.length) : url.replace(/^\//, ""),
      );

      const bundle = BUNDLES.find((name) => name === path);
      const source = bundle ? join(repoRoot, bundle) : undefined;
      const page = sourceOf.get(path);

      if (!source && !page) return next();

      const file = source ?? join(siteConfig.srcDir, page!);
      if (!existsSync(file)) return next();

      void readFile(file, "utf8").then((text) => {
        // `text/plain` so a browser renders it instead of downloading it — "View as Markdown" is
        // meant to be read in a tab. `charset` is explicit because these files carry em dashes and
        // arrows throughout, and a sniffed charset mangles them.
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(page ? stripFrontmatter(text) : text);
      });
    });
  },
});
