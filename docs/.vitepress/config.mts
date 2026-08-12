import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { tabsMarkdownPlugin } from "vitepress-plugin-tabs";

// The docs site. `docs/` is VitePress's default srcDir, so every markdown file here stays exactly
// where README.md, llms.txt and scripts/generate-llms-full.mjs already point at it — the site is
// configuration layered over the repo's docs, not a copy of them.
//
// Served from GitHub Pages as a *project* site (skein-js.github.io/skein-js), hence `base`. Swap in
// a custom domain by adding docs/public/CNAME and deleting the `base` line.
const BASE = "/skein-js/";
const ORIGIN = "https://skein-js.github.io";
const REPO = "https://github.com/skein-js/skein-js";

/**
 * A page's meta description, taken from its first real paragraph.
 *
 * Frontmatter would be the conventional place, but every doc here is also read as raw Markdown on
 * GitHub and most of them are concatenated into llms-full.txt by scripts/generate-llms-full.mjs —
 * (`docs/index.md` is the one exception: it is a `layout: home` page, so its hero and features have
 * to live in frontmatter, and the bundle generator strips that block back out) —
 * which is a plain readFile+concat, so YAML preambles would leak straight into the bundle. Deriving
 * the description at build time keeps the source files as they are and cannot drift from them.
 */
const describePage = (markdown: string): string | undefined => {
  const paragraph = markdown
    .replace(/^---\n.*?\n---\n/s, "") // frontmatter, should any page ever grow one
    .replace(/^```.*?^```/gms, "") // fenced code
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .find(
      (block) =>
        block.length > 0 &&
        !block.startsWith("#") && // headings
        !block.startsWith(">") && // the "if you want to *use* skein-js" notes
        !block.startsWith("|") && // tables
        !block.startsWith("<") && // raw HTML, badge rows
        !block.startsWith("-") && // list items, e.g. a Contents block
        !block.startsWith("["), // a bare link line
    );

  if (!paragraph) return undefined;

  const prose = paragraph
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (prose.length <= 155) return prose;
  return `${prose.slice(0, 155).replace(/\s+\S*$/, "")}…`;
};

export default withMermaid(
  defineConfig({
    title: "skein-js",
    // The site-wide fallback description, and the positioning line used verbatim across the README,
    // the npm packages and the social card. Kept under ~155 characters because that is where search
    // engines truncate — a longer one is not "more description", it is a description with the end cut
    // off. `describePage` below holds derived per-page descriptions to the same bound.
    description:
      "The open-source LangGraph Platform alternative for TypeScript. Self-host LangGraph.js agents with threads, streaming, human-in-the-loop, memory and crons.",
    base: BASE,
    cleanUrls: true,
    lastUpdated: true,

    sitemap: { hostname: `${ORIGIN}${BASE}` },

    // Site-wide social/meta tags. Per-page og:title, og:description and canonical are added in
    // transformPageData below — these are only the values that never vary.
    head: [
      // The mark is a stroked SVG, so it inherits nothing and needs no light/dark variant here — the
      // icon cut is a single flat blue that holds against both browser chromes. Apple ignores SVG
      // favicons and does not composite transparency, hence the PNG on its own white ground.
      ["link", { rel: "icon", type: "image/svg+xml", href: `${BASE}favicon.svg` }],
      ["link", { rel: "apple-touch-icon", href: `${BASE}apple-touch-icon.png` }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:site_name", content: "skein-js" }],
      ["meta", { property: "og:locale", content: "en_US" }],
      // `summary_large_image` + an absolute og:image is what makes a posted link render as a card
      // rather than a line of grey text. Absolute because crawlers do not resolve `base`-relative
      // paths. Regenerate the PNG with `pnpm docs:og` when the pitch on it changes.
      // LinkedIn reads only the og:* tags (never twitter:*), wants an absolute URL that resolves with
      // no redirect, and caches what it scrapes for about a week — so after a deploy that changes any
      // of these, re-scrape via https://www.linkedin.com/post-inspector/ or the old card sticks.
      // `secure_url`, `type` and `alt` are the three it most often wants and VitePress does not add.
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { property: "og:image", content: `${ORIGIN}${BASE}og.png` }],
      ["meta", { property: "og:image:secure_url", content: `${ORIGIN}${BASE}og.png` }],
      ["meta", { property: "og:image:type", content: "image/png" }],
      ["meta", { property: "og:image:width", content: "1200" }],
      ["meta", { property: "og:image:height", content: "630" }],
      [
        "meta",
        {
          property: "og:image:alt",
          content: "skein-js — the open-source LangGraph Platform alternative, for TypeScript",
        },
      ],
      ["meta", { name: "twitter:image", content: `${ORIGIN}${BASE}og.png` }],
      ["meta", { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#ffffff" }],
      ["meta", { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#000000" }],
    ],

    transformPageData(pageData, { siteConfig }) {
      // With `rewrites`, relativePath is the served route and filePath the file on disk.
      const source = join(siteConfig.srcDir, pageData.filePath || pageData.relativePath);
      const route = pageData.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
      const url = `${ORIGIN}${BASE}${route}`;

      const description =
        pageData.frontmatter.description ?? describePage(readFileSync(source, "utf8"));
      // index.md's H1 is already "skein-js — Overview", so the default " | skein-js" suffix renders
      // "skein-js — Overview | skein-js". Suppress it wherever the heading already names the project —
      // the <title> is the single most valuable string on the page for search.
      const selfTitled = pageData.title?.includes("skein-js") ?? false;
      if (selfTitled) pageData.titleTemplate = false;

      const title = !pageData.title
        ? "skein-js"
        : selfTitled
          ? pageData.title
          : `${pageData.title} | skein-js`;

      pageData.frontmatter.head ??= [];
      pageData.frontmatter.head.push(
        // Canonical: /page and /page.html both resolve, and Pages will also serve the base path with
        // and without a trailing slash. One declared URL keeps those from splitting ranking signals.
        ["link", { rel: "canonical", href: url }],
        ["meta", { property: "og:url", content: url }],
        ["meta", { property: "og:title", content: title }],
        ["meta", { name: "twitter:title", content: title }],
      );

      if (description) {
        pageData.description = description;
        pageData.frontmatter.head.push(
          ["meta", { property: "og:description", content: description }],
          ["meta", { name: "twitter:description", content: description }],
        );
      }
    },

    // Mermaid reaches dayjs, which is CJS. Left unlisted, the dev server serves it raw over @fs and
    // the page dies on `does not provide an export named 'default'` — diagrams silently fail to render,
    // while the production build is fine because rollup handles the interop itself. Naming them here
    // makes esbuild pre-bundle both and emit the ESM wrapper the dev server needs.
    vite: {
      optimizeDeps: { include: ["mermaid", "dayjs"] },
    },

    // `:::tabs` containers, used on the landing page so the three on-ramps are a choice rather than
    // three stacked walls of content. Client half is registered in theme/index.ts.
    markdown: {
      config(md) {
        md.use(tabsMarkdownPlugin);
      },
    },

    // VitePress does not treat README.md as a directory index, so proposals/README.md would serve at
    // /proposals/README and /proposals/ would 404. Rewriting keeps the file named README.md — which is
    // what makes GitHub render it when you open the folder — while the site serves it at /proposals/.
    rewrites: { "proposals/README.md": "proposals/index.md" },

    // The site is for getting up and running with skein, not for working on skein. These three are
    // contributor docs about the internals — they stay in the repo (AGENTS.md sends contributors
    // straight to them) and every in-site reference to them is an absolute GitHub link.
    srcExclude: ["reuse.md", "code-practices.md", "testing.md"],

    // Those three are excluded but still exist on disk, so a *relative* link to one from a page that IS
    // on the site resolves to nothing and hard-fails the build — which then blocks the Pages deploy.
    // In-site references to them use absolute GitHub URLs; this keeps a stray relative one from taking
    // the deploy down, since the link still works for anyone reading the file on GitHub.
    ignoreDeadLinks: [/^(\.\/)?(reuse|code-practices|testing)(\.md)?(#.*)?$/],

    // Note: the ```caddyfile fence in deploy-vps.md makes Shiki print "language not loaded, falling
    // back to txt" on each render pass. That is the correct outcome — GitHub's linguist highlights
    // Caddyfile and Shiki has no grammar for it, so the fence stays as-is and the site renders it as
    // plain text. Do not "fix" this with `markdown.languageAlias`: aliasing turns the graceful fallback
    // into a hard build error ("Language `caddyfile` not found"), for both `text` and `txt` targets.

    themeConfig: {
      // The display cut, whose three arcs are three steps of the accent so the strand reads as passing
      // in front of and behind itself. Two files rather than one `currentColor` mark because the ramp
      // has to shift on a dark ground, not just invert.
      logo: { light: "/skein-knot.svg", dark: "/skein-knot-dark.svg", alt: "" },

      // Local minisearch — no Algolia account, no network call, no crawler to keep in sync.
      search: { provider: "local" },

      nav: [
        { text: "Why skein-js", link: "/why" },
        { text: "Guide", link: "/getting-started" },
        { text: "Features", link: "/features" },
        { text: "Console", link: "/console" },
        { text: "Protocol", link: "/agent-protocol" },
        { text: "Deploy", link: "/deploy" },
        { text: "Roadmap", link: "/roadmap" },
      ],

      socialLinks: [{ icon: "github", link: REPO }],

      editLink: {
        pattern: `${REPO}/edit/main/docs/:path`,
        text: "Edit this page on GitHub",
      },

      // Ordered as a journey, not as a filing cabinet: decide whether to use it, build something,
      // understand what you built, ship it, extend it. Hand-written on purpose — docs/ is flat, so no
      // directory layout would produce this, and the ordering is the argument.
      //
      // Every group sets `collapsed`, which is what makes it collapsible at all; omitting it pins a
      // group open. The long tails — recipes, the per-platform deploy guides, proposals — are nested
      // one level down so they are reachable without dominating the scroll.
      sidebar: [
        {
          text: "Decide",
          collapsed: false,
          items: [
            { text: "Overview", link: "/" },
            { text: "Why skein-js", link: "/why" },
            { text: "Features", link: "/features" },
            { text: "Roadmap", link: "/roadmap" },
          ],
        },
        {
          text: "Build",
          collapsed: false,
          items: [
            { text: "Your first agent", link: "/your-first-agent" },
            { text: "Getting started", link: "/getting-started" },
            { text: "Scaffolding a project", link: "/scaffolding" },
            { text: "Framework adapters", link: "/adapters" },
            { text: "Frontend SDKs & useStream", link: "/react-sdk" },
            {
              // The default path is the three entries above. These four are alternatives — a different
              // on-ramp, or a smaller surface — and listing them as peers made "Build" read as five
              // competing ways to start, with the two taglined "simplified"/"in-code" pulling hardest.
              text: "Other ways in",
              collapsed: true,
              items: [
                { text: "LangGraph CLI compatibility", link: "/langgraph-cli-compat" },
                { text: "Embedding a graph in code", link: "/embedding" },
                { text: "A graph as a plain endpoint", link: "/serving-a-single-graph" },
                { text: "Using skein-js (reference)", link: "/using-skein" },
              ],
            },
            {
              text: "Recipes",
              collapsed: true,
              items: [
                { text: "Overview", link: "/recipes/" },
                { text: "Serving", link: "/recipes/serving" },
                { text: "Running agents", link: "/recipes/running-agents" },
                { text: "Memory", link: "/recipes/memory" },
                { text: "Production", link: "/recipes/production" },
              ],
            },
          ],
        },
        {
          text: "Understand",
          collapsed: false,
          items: [
            { text: "Building blocks", link: "/building-blocks" },
            { text: "LangGraph essentials", link: "/langgraph-essentials" },
            { text: "State, context & persistence", link: "/state-and-context" },
            { text: "Threads & time travel", link: "/threads" },
            { text: "Runs & multitask", link: "/runs" },
            { text: "Streaming", link: "/streaming" },
            { text: "Human-in-the-loop", link: "/human-in-the-loop" },
            { text: "Long-term memory", link: "/memory" },
            { text: "Assistants", link: "/assistants" },
            { text: "Background jobs", link: "/background-jobs" },
            { text: "Crons", link: "/crons" },
            { text: "Webhooks & delivery", link: "/webhooks" },
          ],
        },
        {
          text: "Ship",
          collapsed: false,
          items: [
            { text: "Deploy anywhere", link: "/deploy" },
            { text: "Storage", link: "/storage" },
            { text: "Runs & Redis", link: "/runs-and-redis" },
            { text: "The console", link: "/console" },
            { text: "Errors & logging", link: "/errors-and-logging" },
            { text: "Observability", link: "/observability" },
            { text: "Performance", link: "/performance" },
            { text: "Profiling", link: "/profiling" },
            { text: "Bundling", link: "/bundling" },
            {
              text: "Platform guides",
              collapsed: true,
              items: [
                { text: "Google Cloud Run", link: "/deploy-cloud-run" },
                { text: "AWS", link: "/deploy-aws" },
                { text: "Fly.io", link: "/deploy-fly" },
                { text: "Railway", link: "/deploy-railway" },
                { text: "Render", link: "/deploy-render" },
                { text: "Kubernetes", link: "/deploy-kubernetes" },
                { text: "VPS", link: "/deploy-vps" },
                { text: "Serverless", link: "/deploy-serverless" },
              ],
            },
          ],
        },
        {
          text: "Extend",
          collapsed: true,
          items: [
            { text: "Agent Protocol", link: "/agent-protocol" },
            { text: "Building an adapter", link: "/building-an-adapter" },
            { text: "Building a runner", link: "/building-a-runner" },
            {
              text: "Proposals",
              collapsed: true,
              items: [
                { text: "Overview", link: "/proposals/" },
                { text: "Inbound events", link: "/proposals/inbound-events" },
              ],
            },
            { text: "Changelog", link: "https://github.com/skein-js/skein-js/releases" },
            {
              text: "Contributing",
              link: "https://github.com/skein-js/skein-js/blob/main/CONTRIBUTING.md",
            },
          ],
        },
      ],

      footer: {
        message: "Released under the Apache-2.0 License.",
        copyright: `<a href="${REPO}">skein-js on GitHub</a>`,
      },
    },
  }),
  {
    // `base` is the only mermaid theme that yields to CSS. Everything visual is then set in
    // theme/style.css against the site's own --vp-c-* variables, which is what makes a diagram follow
    // light/dark — mermaid resolves themeVariables once at render and has no second pass on a toggle.
    mermaid: {
      theme: "base",
      // SVG text labels, not foreignObject HTML: mermaid sizes each box by measuring the label in its
      // own font, and the page's font is wider, so HTML labels overflow the box they were measured
      // for — "checkpoint" renders as "checkpoin". Pinning the family keeps measure and paint agreed.
      flowchart: { useMaxWidth: true, htmlLabels: true, padding: 12 },
      themeVariables: { fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: "14px" },
    },
  },
);
