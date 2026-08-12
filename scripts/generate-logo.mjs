#!/usr/bin/env node
// Generate the skein-js mark into docs/public/. Run `pnpm docs:logo` after changing anything below.
//
// The mark is a trefoil knot: one unbroken thread crossing itself three times, which is what a skein
// is. It is defined by a formula rather than drawn, so it lives here as a generator for the same
// reason og-card.html does — an asset nobody can regenerate is an asset that rots.
//
//   C(t)  = (sin t + 2 sin 2t,  cos t - 2 cos 2t)
//   C'(t) = (cos t + 4 cos 2t, -sin t + 4 sin 2t)
//
// The strand dives under where sin 3t peaks (t = pi/6 + k*2pi/3), so the three crossings sit there.
// Breaking the path at those points is what makes the weave read, and it keeps every cut to a single
// flat colour — no knockout strokes in the host's background colour, which would not survive being
// placed on anything else.
//
// Curves, not a polyline: each arc is emitted as cubic Beziers straight from the derivative via the
// Hermite identity, so the only error is the piece count. At 5 pieces per arc the worst deviation is
// ~0.01 of the 64-unit box, which is invisible and a third the size of the equivalent polyline.

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "docs/public");

const TAU = Math.PI * 2;
const PIECES_PER_ARC = 5;
const round = (n) => Math.round(n * 100) / 100;

/** The three steps of the accent, back to front, so colour carries the same depth as the gaps. */
const RAMP_LIGHT = ["#0A4FA8", "#0070F0", "#4E9BF5"];
const RAMP_DARK = ["#2B7FD8", "#4DA0FF", "#93C6FF"];
/** The icon cut is one flat colour: below ~32px the three tints muddy into one anyway. */
const FLAT = "#0070F0";

const curve = (t) => [Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t)];
const derivative = (t) => [Math.cos(t) + 4 * Math.cos(2 * t), -Math.sin(t) + 4 * Math.sin(2 * t)];

/** Scale and centre the knot in a 64 box, leaving room for half a stroke plus `pad`. */
function fitToBox(strokeWidth, pad = 3) {
  const samples = Array.from({ length: 4001 }, (_, i) => curve((i / 4000) * TAU));
  const xs = samples.map((p) => p[0]);
  const ys = samples.map((p) => p[1]);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const inset = pad + strokeWidth / 2;
  const scale = Math.min((64 - inset * 2) / (maxX - minX), (64 - inset * 2) / (maxY - minY));
  return {
    scale,
    offsetX: (64 - (maxX - minX) * scale) / 2 - minX * scale,
    offsetY: (64 - (maxY - minY) * scale) / 2 - minY * scale,
  };
}

/**
 * Arc length against parameter. The crossing gaps have to be specified in user units — a gap that is
 * constant in `t` would be visibly wider where the curve moves fastest.
 */
function arcLengthTable(box, steps = 8000) {
  const parameters = [];
  const lengths = [0];
  let total = 0;
  let previous = null;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * TAU;
    const [x, y] = curve(t);
    const point = [x * box.scale + box.offsetX, y * box.scale + box.offsetY];
    if (previous) total += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    parameters.push(t);
    if (i > 0) lengths.push(total);
    previous = point;
  }
  return { parameters, lengths, total };
}

const search = (values, target) => {
  let low = 0;
  let high = values.length - 1;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (values[mid] < target) low = mid;
    else high = mid;
  }
  return low;
};

/** The three arcs between crossings, as [startT, endT] pairs. */
function arcRanges(strokeWidth, box) {
  const table = arcLengthTable(box);
  const gap = strokeWidth * 2.15;
  const crossings = [0, 1, 2].map((k) => Math.PI / 6 + (k * TAU) / 3);
  const atLength = crossings.map((t) => table.lengths[search(table.parameters, t)]);
  return atLength.map((start, index) => {
    const next = index === 2 ? atLength[0] + table.total : atLength[index + 1];
    const from = table.parameters[search(table.lengths, start + gap / 2)];
    const to = table.parameters[search(table.lengths, (next - gap / 2) % table.total)];
    return [from, to];
  });
}

function arcToBeziers([startT, endT], box) {
  const end = endT < startT ? endT + TAU : endT;
  const step = (end - startT) / PIECES_PER_ARC;
  const at = (t) => {
    const [x, y] = curve(t);
    return [x * box.scale + box.offsetX, y * box.scale + box.offsetY];
  };
  const slope = (t) => {
    const [x, y] = derivative(t);
    return [x * box.scale, y * box.scale];
  };

  let d = "";
  for (let piece = 0; piece < PIECES_PER_ARC; piece++) {
    const a = startT + piece * step;
    const b = a + step;
    const from = at(a);
    const to = at(b);
    const outgoing = slope(a);
    const incoming = slope(b);
    const control1 = [from[0] + (outgoing[0] * step) / 3, from[1] + (outgoing[1] * step) / 3];
    const control2 = [to[0] - (incoming[0] * step) / 3, to[1] - (incoming[1] * step) / 3];
    if (piece === 0) d += `M${round(from[0])} ${round(from[1])}`;
    d += `C${round(control1[0])} ${round(control1[1])} ${round(control2[0])} ${round(control2[1])} ${round(to[0])} ${round(to[1])}`;
  }
  return d;
}

const arcs = (strokeWidth) => {
  const box = fitToBox(strokeWidth);
  return arcRanges(strokeWidth, box).map((range) => arcToBeziers(range, box));
};

const DISPLAY_STROKE = 7;
const ICON_STROKE = 9.5;
const displayArcs = arcs(DISPLAY_STROKE);
const iconArcs = arcs(ICON_STROKE);

const svg = (strokeWidth, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke-width="${strokeWidth}" stroke-linecap="round">\n` +
  `  <title>skein-js</title>\n${body}\n</svg>\n`;

const ramped = (ramp) =>
  svg(
    DISPLAY_STROKE,
    displayArcs.map((d, i) => `  <path stroke="${ramp[i]}" d="${d}"/>`).join("\n"),
  );

const files = {
  // Display cut, for the site header and anywhere the mark is 32px or larger.
  "skein-knot.svg": ramped(RAMP_LIGHT),
  "skein-knot-dark.svg": ramped(RAMP_DARK),
  // One colour, for embroidery, stickers, print, or anywhere the ground is unknown.
  "skein-knot-mono.svg": svg(
    DISPLAY_STROKE,
    displayArcs.map((d) => `  <path stroke="currentColor" d="${d}"/>`).join("\n"),
  ),
  // Icon cut: heavier stroke, wider gaps, flat colour.
  "favicon.svg": svg(
    ICON_STROKE,
    iconArcs.map((d) => `  <path stroke="${FLAT}" d="${d}"/>`).join("\n"),
  ),
};

await mkdir(outDir, { recursive: true });
for (const [name, contents] of Object.entries(files)) {
  await writeFile(path.join(outDir, name), contents, "utf8");
  console.log(`Wrote docs/public/${name} (${contents.length} bytes)`);
}

// iOS ignores SVG favicons and does not composite transparency, so the touch icon is a PNG on its own
// ground. Playwright is resolved from examples/chat-app rather than added at the root, matching
// generate-og.mjs — a headless browser in every contributor's install is a poor trade for a script
// that runs a few times a year.
const require = createRequire(import.meta.url);
let chromium;
try {
  const entry = require.resolve("@playwright/test", {
    paths: [path.join(repoRoot, "examples/chat-app")],
  });
  const playwright = await import(pathToFileURL(entry).href);
  chromium = playwright.chromium ?? playwright.default?.chromium;
} catch {
  console.warn(
    "Skipped apple-touch-icon.png — Playwright is not installed. Run\n" +
      "  pnpm --filter @skein-js/example-chat-app exec playwright install chromium",
  );
}

if (chromium) {
  const page = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:180px;height:180px}
    body{background:#fff;display:flex;align-items:center;justify-content:center}
  </style>${ramped(RAMP_LIGHT).replace("<svg", '<svg width="144" height="144"')}`;
  const browser = await chromium.launch();
  const tab = await browser.newPage({
    viewport: { width: 180, height: 180 },
    deviceScaleFactor: 1,
  });
  await tab.setContent(page);
  await tab.screenshot({ path: path.join(outDir, "apple-touch-icon.png") });
  await browser.close();
  console.log("Wrote docs/public/apple-touch-icon.png (180×180)");
}
