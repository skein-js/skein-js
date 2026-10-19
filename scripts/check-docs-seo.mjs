import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Validate rendered output, including the project-site base path, rather than just config values.
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.argv[2] ?? path.join(root, "docs/.vitepress/dist"));
const site = new URL("https://skein-js.github.io/skein-js/");
const decodeEntities = (value) =>
  value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity) => {
    if (entity.startsWith("#"))
      return String.fromCodePoint(
        entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10),
      );
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()];
  });
const attributesOf = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [
      match[1],
      decodeEntities(match[2] ?? match[3]),
    ]),
  );
const exactlyOne = (values, label) => {
  assert.equal(values.length, 1, `${label}: expected exactly one, got ${values.length}`);
  assert(values[0]?.trim(), `${label}: must not be empty`);
  return values[0];
};
const sitemap = await readFile(path.join(output, "sitemap.xml"), "utf8");
const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
  decodeEntities(match[1]),
);
const sitemapUrls = new Set(locations);
assert(locations.length > 0, "Sitemap must contain pages");
assert.equal(sitemapUrls.size, locations.length, "Sitemap must not duplicate URLs");

const filenames = (await readdir(output, { recursive: true })).filter((name) =>
  name.endsWith(".html"),
);
const pageUrls = new Set();
const titles = new Set();
const descriptions = new Set();
for (const filename of filenames) {
  const html = await readFile(path.join(output, filename), "utf8");
  const head = exactlyOne(
    [...html.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head>/g)].map((match) => match[1]),
    `${filename} head`,
  );
  const tags = [...head.matchAll(/<(meta|link)\b[^>]*>/g)].map((match) => ({
    tag: match[1],
    ...attributesOf(match[0]),
  }));
  const metaValues = (attribute, key) =>
    tags.filter((tag) => tag.tag === "meta" && tag[attribute] === key).map((tag) => tag.content);
  const meta = (attribute, key) => exactlyOne(metaValues(attribute, key), `${filename} ${key}`);
  const robots = metaValues("name", "robots").join(",");
  if (filename === "404.html") {
    assert(/\bnoindex\b/i.test(robots), "404 page must be noindex");
    continue;
  }
  assert(!/\bnoindex\b/i.test(robots), `${filename}: published page must be indexable`);
  const route = filename
    .split(path.sep)
    .join("/")
    .replace(/(^|\/)index\.html$/, "$1")
    .replace(/\.html$/, "");
  const url = new URL(route, site).href;
  pageUrls.add(url);
  assert(sitemapUrls.has(url), `${filename}: missing from sitemap`);
  const canonical = exactlyOne(
    tags.filter((tag) => tag.tag === "link" && tag.rel === "canonical").map((tag) => tag.href),
    `${filename} canonical`,
  );
  assert.equal(canonical, url, `${filename}: canonical must match its sitemap URL`);
  assert.equal(meta("property", "og:url"), url, `${filename}: og:url`);
  const title = decodeEntities(
    exactlyOne(
      [...head.matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1]),
      `${filename} title`,
    ),
  );
  assert(title.includes("skein-js"), `${filename}: title must identify the site`);
  assert(!titles.has(title), `${filename}: duplicate title ${title}`);
  titles.add(title);
  assert.equal(meta("property", "og:title"), title, `${filename}: og:title`);
  assert.equal(meta("name", "twitter:title"), title, `${filename}: twitter:title`);
  const description = meta("name", "description");
  assert(!descriptions.has(description), `${filename}: duplicate description`);
  descriptions.add(description);
  assert.equal(meta("property", "og:description"), description, `${filename}: og:description`);
  assert.equal(
    meta("name", "twitter:description"),
    description,
    `${filename}: twitter:description`,
  );
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
  assert.equal(meta("property", "og:image"), new URL("og.png", site).href);
  assert.equal(meta("property", "og:image:secure_url"), meta("property", "og:image"));
  assert.equal(meta("name", "twitter:image"), meta("property", "og:image"));
  assert.equal(meta("property", "og:image:type"), "image/png");
  assert.equal(meta("property", "og:image:width"), "1200");
  assert.equal(meta("property", "og:image:height"), "630");
  meta("property", "og:image:alt");
}
assert.deepEqual(pageUrls, sitemapUrls, "Sitemap must list only rendered, canonical pages");
for (const route of ["", "deploy", "local-deployment", "getting-started", "storage", "embedding"])
  assert(pageUrls.has(new URL(route, site).href), `Missing deployment entry page: ${route}`);
const home = await readFile(path.join(output, "index.html"), "utf8");
for (const route of ["deploy", "local-deployment"])
  assert(home.includes(`href="${site.pathname}${route}"`), `Homepage must link to ${route}`);
const robots = await readFile(path.join(output, "robots.txt"), "utf8");
assert(
  robots.includes(`Sitemap: ${new URL("sitemap.xml", site).href}`),
  "Sitemap hint must match the deployed site",
);
const image = await readFile(path.join(output, "og.png"));
assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Social image must be PNG");
assert.equal(image.readUInt32BE(16), 1200);
assert.equal(image.readUInt32BE(20), 630);
for (const filename of ["llms.txt", "llms-full.txt"])
  assert.deepEqual(
    await readFile(path.join(output, filename)),
    await readFile(path.join(root, filename)),
    `${filename}: deployed copy must match the current root bundle`,
  );
const localMarkdown = await readFile(path.join(output, "local-deployment.md"), "utf8");
assert(
  localMarkdown.trimStart().startsWith("# Durable local deployment"),
  "Markdown twin must strip SEO frontmatter",
);
console.log(
  `DOCS_SEO_OK ${pageUrls.size} pages: titles, descriptions, canonical/social URLs, sitemap, social image, deployment links, and LLM assets`,
);
