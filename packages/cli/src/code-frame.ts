// A source excerpt around the line a graph actually threw on — the thing that turns "TypeError:
// cannot read properties of undefined" into "…and here is the line". This is what LangGraph
// Platform's own logger does with `@babel/code-frame`; the surface needed here is small enough to
// keep dependency-free, matching colors.ts.
//
// It relies on the stack already pointing at original source. In `skein dev` it does: vite's module
// runner installs source-map interception, so a stack frame names the user's `.ts` file and line,
// not the transformed output.
//
// Two rules keep "read a file named by a string" from becoming an arbitrary-file-read primitive,
// because a graph's error message is frequently attacker-influenced (a raw LLM response, a fetched
// document, or just `throw new Error(\`bad mode: ${input.mode}\`)` over a client-supplied input):
//
//   1. Frames are parsed from the *frame region only*. `Error.stack` is `${name}: ${message}` followed
//      by the frames, so a newline inside the message renders as an extra line that looks exactly
//      like a frame — and sits ahead of every genuine one. See `codeFrameForStack`.
//   2. The file must resolve inside the project root. A code frame is only ever useful for the
//      user's own source, so nothing outside it is worth reading.

import { readFileSync } from "node:fs";
import path from "node:path";

/** Lines of context shown either side of the offending one. */
const CONTEXT_LINES = 2;

/** A source position parsed out of a stack frame. */
export interface StackLocation {
  file: string;
  line: number;
  column: number;
}

/** `at fn (/path/file.ts:42:11)` or the bare `at /path/file.ts:42:11` form. */
const STACK_FRAME = /^\s*at (?:.*?\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * The first stack frame that belongs to the user's own code — skipping `node:` internals, bundled
 * dependencies, and skein's own frames, which are never where the interesting bug is.
 *
 * Takes the **frame region** of a stack, not the whole string: see the header note above and
 * {@link codeFrameForStack}, which is what callers should use.
 *
 * Returns undefined when the input is missing, unparseable, or entirely framework frames.
 */
export function findUserFrame(frames: string | undefined): StackLocation | undefined {
  if (!frames) return undefined;
  for (const raw of frames.split("\n")) {
    const match = STACK_FRAME.exec(raw);
    if (!match) continue;
    const [, file, line, column] = match;
    if (!file || !line || !column) continue;
    if (file.startsWith("node:") || file.includes("node_modules")) continue;
    // A file: URL is what vite's source-mapped frames use; normalize it to a path we can read.
    const resolved = file.startsWith("file://") ? fileUrlToPath(file) : file;
    if (!resolved.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(resolved)) continue;
    return { file: resolved, line: Number(line), column: Number(column) };
  }
  return undefined;
}

function fileUrlToPath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

/** True when `file` resolves inside `root` (or is `root` itself). */
function isInside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * A few source lines around `location`, with the offending one marked by a `>` and a caret under the
 * column. `sourceRoot` bounds what may be read — a location outside it yields undefined rather than
 * a file read. Also returns undefined when the file can't be read or the line is out of range: a
 * failure to *illustrate* a failure must never become a failure of its own.
 *
 * ```
 *   40 |   const model = getModel();
 *   41 |
 * > 42 |   const res = await model.invoke(state.messages);
 *      |                     ^
 *   43 |   return { messages: [res] };
 * ```
 */
export function renderCodeFrame(location: StackLocation, sourceRoot: string): string | undefined {
  if (!isInside(sourceRoot, location.file)) return undefined;

  let source: string;
  try {
    source = readFileSync(location.file, "utf8");
  } catch {
    return undefined;
  }

  const lines = source.split("\n");
  if (location.line < 1 || location.line > lines.length) return undefined;

  const first = Math.max(1, location.line - CONTEXT_LINES);
  const last = Math.min(lines.length, location.line + CONTEXT_LINES);
  const gutterWidth = String(last).length;

  const rendered: string[] = [];
  for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
    const isOffending = lineNumber === location.line;
    const gutter = String(lineNumber).padStart(gutterWidth, " ");
    rendered.push(`${isOffending ? ">" : " "} ${gutter} | ${lines[lineNumber - 1] ?? ""}`);
    if (isOffending && location.column > 0) {
      const caretPad = " ".repeat(Math.max(0, location.column - 1));
      rendered.push(`  ${" ".repeat(gutterWidth)} | ${caretPad}^`);
    }
  }
  return rendered.join("\n");
}

/**
 * Drop the `${name}: ${message}` header from a stack, leaving only the frames.
 *
 * This is the security-relevant step. A message is often attacker-influenced, and a newline in one
 * produces a line indistinguishable from a real frame — placed, by construction, ahead of every real
 * frame. Counting the header's own lines is exact: V8 builds `stack` by joining the header and the
 * frames with newlines, so the frame region always begins at that offset.
 */
function frameRegion(error: Error): string | undefined {
  const stack = error.stack;
  if (typeof stack !== "string") return undefined;
  const name = typeof error.name === "string" ? error.name : "Error";
  const message = typeof error.message === "string" ? error.message : "";
  const headerLines = `${name}: ${message}`.split("\n").length;
  const lines = stack.split("\n");
  // A stack that doesn't start with the header we expect (a hand-set `stack`, a non-V8 engine) is
  // not worth guessing at — skip the frame rather than risk parsing the message region.
  if (!stack.startsWith(name) && !stack.startsWith(message)) return undefined;
  return lines.slice(headerLines).join("\n");
}

/**
 * The code frame for the first user-owned frame of `error`, when one can be produced. `sourceRoot`
 * bounds which files may be read.
 */
export function codeFrameForStack(error: Error, sourceRoot: string): string | undefined {
  const location = findUserFrame(frameRegion(error));
  return location ? renderCodeFrame(location, sourceRoot) : undefined;
}
