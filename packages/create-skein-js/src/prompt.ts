// A minimal interactive prompt over node:readline/promises.
//
// No dependency, for the same reason colors.ts has none: on the `npm create` path every dependency
// is a cold-cache download standing between the user and their first impression of the project, and
// the surface here is one text field and one single-select.
//
// Selection is a numbered list rather than arrow-key navigation. That needs no raw mode and no
// cursor arithmetic, works under every terminal, multiplexer and CI harness, and is testable by
// handing in a fake question function.

import { bold, cyan, dim } from "./colors.js";

/** Asks one question and resolves with the raw answer. `readline`'s `question`, narrowed. */
export type AskQuestion = (query: string) => Promise<string>;

/**
 * Whether we may prompt at all.
 *
 * Both streams must be a TTY, `--yes` must not have been passed, and `CI` must be unset. Without
 * this gate a `create-skein-js` invocation inside a Dockerfile or a CI job hangs forever waiting for
 * an answer nobody can give — the classic way a scaffolder breaks an automated pipeline.
 */
export function canPrompt(options: { readonly yes: boolean }): boolean {
  return (
    !options.yes &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    process.env.CI === undefined
  );
}

/** Ask for a line of text, falling back to `fallback` on an empty answer. */
export async function promptText(
  ask: AskQuestion,
  question: string,
  fallback: string,
): Promise<string> {
  const answer = await ask(`${bold(question)} ${dim(`(${fallback})`)} `);
  const trimmed = answer.trim();
  return trimmed === "" ? fallback : trimmed;
}

/** One selectable option in {@link promptChoice}. */
export interface PromptChoice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

/**
 * Ask the user to pick one option by number. An empty answer, or anything unrecognised, takes
 * `defaultValue` — a scaffolder should never punish a stray keystroke with an error.
 */
export async function promptChoice<T extends string>(
  ask: AskQuestion,
  question: string,
  choices: readonly PromptChoice<T>[],
  defaultValue: T,
): Promise<T> {
  const defaultIndex = choices.findIndex((choice) => choice.value === defaultValue);
  const lines = [
    bold(question),
    ...choices.map((choice, index) => {
      const marker = choice.value === defaultValue ? cyan("›") : " ";
      const hint = choice.hint === undefined ? "" : dim(` — ${choice.hint}`);
      return `  ${marker} ${index + 1}) ${choice.label}${hint}`;
    }),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  const answer = (await ask(dim(`  Choose 1-${choices.length} [${defaultIndex + 1}] `))).trim();
  const chosen = choices[Number.parseInt(answer, 10) - 1];
  return chosen?.value ?? defaultValue;
}
