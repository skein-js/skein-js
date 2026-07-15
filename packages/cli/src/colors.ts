// Tiny ANSI color helper for `skein dev`'s console output (the startup banner + the dev logger).
// No dependency — the surface is a handful of SGR codes. Color is disabled automatically for
// non-TTY stdout and when `NO_COLOR` is set, so piped/redirected output and CI logs stay plain text.

/** Whether to emit ANSI color: off for piped output and when the user set `NO_COLOR`. */
export const colorEnabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

/** Wrap text in an ANSI SGR code (or return it unchanged when color is disabled). */
const paint =
  (code: number) =>
  (text: string): string =>
    colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;

export const green = paint(32);
export const yellow = paint(33);
export const red = paint(31);
export const cyan = paint(36);
export const bold = paint(1);
export const dim = paint(2);
