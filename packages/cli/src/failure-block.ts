// The chrome around a CLI failure report: a titled rule, an indented body, a closing rule.
//
// Two reports use it — a graph that crashed mid-run, and a graph that could not be loaded at all —
// and they must look like siblings, because they are the two ways the same graph fails. Shared here
// rather than duplicated so the fencing, the indent, and the label column can only be changed for
// both at once.
//
// Deliberately fenced by *text* rather than color alone: `colorEnabled` is false for every piped
// log, CI run, and test, and a failure needs to stand out from the surrounding request lines
// precisely there.

import { dim, red } from "./colors.js";

/** Indent for a block's body — aligns it under the `error:`/`warn:` level prefix. */
export const INDENT = "       ";

/** Width of the rules fencing a block. Fixed rather than derived from the terminal: dev output is
 *  often piped, and a stable width reads and diffs better than a reflowing one. */
const RULE_WIDTH = 66;

/** Indent every line of a block, so multi-line output stays under the level prefix. */
export function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `${INDENT}${line}`)
    .join("\n");
}

/** One `label      value` row of a block's identity section. */
export function labelled(label: string, value: string): string {
  return `${dim(label.padEnd(10))}${value}`;
}

/** `──────── GRAPH RUN FAILED ────────`, centered in the rule. */
function titleRule(title: string): string {
  const framed = ` ${title} `;
  const dashes = Math.max(0, RULE_WIDTH - framed.length);
  const left = "─".repeat(Math.floor(dashes / 2));
  return `${left}${framed}${"─".repeat(dashes - left.length)}`;
}

/**
 * A titled, fenced, indented block. `sections` are separated by a blank line each — by convention
 * identity first, then the offending source, then the detail — and empty ones are dropped so a
 * section that could not be produced (no code frame, say) leaves no gap behind.
 */
export function fencedBlock(title: string, sections: readonly string[]): string {
  const body = sections.filter((section) => section.length > 0);
  return [
    "",
    indent(red(titleRule(title))),
    body.map((section) => indent(section)).join(`\n${INDENT}\n`),
    indent(red("─".repeat(RULE_WIDTH))),
    "",
  ].join("\n");
}
