import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig } from "vitepress";

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
 * GitHub and 25 of them are concatenated into llms-full.txt by scripts/generate-llms-full.mjs —
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

export default defineConfig({
  title: "skein-js",
  description:
    "The open-source alternative to LangGraph Platform for TypeScript — a self-hosted Agent Protocol server for LangGraph.js.",
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,

  sitemap: { hostname: `${ORIGIN}${BASE}` },

  // Site-wide social/meta tags. Per-page og:title, og:description and canonical are added in
  // transformPageData below — these are only the values that never vary.
  head: [
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "skein-js" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { name: "twitter:card", content: "summary" }],
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
    // Local minisearch — no Algolia account, no network call, no crawler to keep in sync.
    search: { provider: "local" },

    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Protocol", link: "/agent-protocol" },
      { text: "Deploy", link: "/deploy" },
      { text: "Roadmap", link: "/roadmap" },
    ],

    socialLinks: [{ icon: "github", link: REPO }],

    editLink: {
      pattern: `${REPO}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },

    // Mirrors the documentation map in index.md. That table stays the in-repo index; this is the
    // canonical one for readers on the web.
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "Using skein-js", link: "/using-skein" },
        ],
      },
      {
        text: "Recipes",
        items: [
          { text: "Overview", link: "/recipes/" },
          { text: "Serving", link: "/recipes/serving" },
          { text: "Running agents", link: "/recipes/running-agents" },
          { text: "Memory", link: "/recipes/memory" },
          { text: "Production", link: "/recipes/production" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "LangGraph CLI compatibility", link: "/langgraph-cli-compat" },
          { text: "Embedding in your server", link: "/embedding" },
          { text: "Serving a single graph", link: "/serving-a-single-graph" },
          { text: "The console", link: "/console" },
        ],
      },
      {
        text: "Protocol & streaming",
        items: [
          { text: "Agent Protocol", link: "/agent-protocol" },
          { text: "Streaming", link: "/streaming" },
          { text: "Frontend SDKs & useStream", link: "/react-sdk" },
          { text: "Building an adapter", link: "/building-an-adapter" },
        ],
      },
      {
        text: "Storage & runs",
        items: [
          { text: "Storage", link: "/storage" },
          { text: "Memory", link: "/memory" },
          { text: "Runs & Redis", link: "/runs-and-redis" },
          { text: "Crons", link: "/crons" },
        ],
      },
      {
        text: "Operations",
        items: [
          { text: "Errors & logging", link: "/errors-and-logging" },
          { text: "Observability", link: "/observability" },
          { text: "Performance", link: "/performance" },
          { text: "Profiling", link: "/profiling" },
          { text: "Bundling", link: "/bundling" },
        ],
      },
      {
        text: "Deploy",
        collapsed: false,
        items: [
          { text: "Deploy anywhere", link: "/deploy" },
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
      {
        text: "Project",
        collapsed: true,
        items: [
          { text: "Roadmap", link: "/roadmap" },
          { text: "Changelog", link: "https://github.com/skein-js/skein-js/releases" },
          {
            text: "Contributing",
            link: "https://github.com/skein-js/skein-js/blob/main/CONTRIBUTING.md",
          },
        ],
      },
      {
        text: "Proposals",
        collapsed: true,
        items: [
          { text: "Overview", link: "/proposals/" },
          { text: "Inbound events", link: "/proposals/inbound-events" },
          { text: "Durable delivery", link: "/proposals/durable-delivery" },
        ],
      },
    ],

    footer: {
      message: "Released under the Apache-2.0 License.",
      copyright: `<a href="${REPO}">skein-js on GitHub</a>`,
    },
  },
});
