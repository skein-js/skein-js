import { promptConfirm, type AskQuestion } from "./prompt.js";

/** Explicit flags win; unattended scaffolding always includes the default tools. */
export async function resolveLinting(options: {
  readonly explicit?: boolean;
  readonly interactive: boolean;
  readonly ask: AskQuestion;
}): Promise<boolean> {
  if (options.explicit !== undefined) return options.explicit;
  return (
    !options.interactive || (await promptConfirm(options.ask, "Include ESLint and Prettier?", true))
  );
}
