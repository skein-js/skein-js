// Driver-flag parsing for `dev` and `start`, extracted so the restriction can be tested. `index.ts`
// declares the commands but has no test of its own — it parses argv on import — and the rule below is
// the load-bearing one in the production entrypoint.

import { InvalidArgumentError } from "@commander-js/extra-typings";

export function parseChoice<const T extends string>(choices: readonly T[], hint?: string) {
  return (value: string): T => {
    if (!(choices as readonly string[]).includes(value)) {
      // `hint` names the alternative when the rejected value is one a user would reasonably expect to
      // work. Commander prints only the message, so "Must be one of: postgres." on its own leaves
      // someone who typed `--store memory` with no idea what to do instead.
      throw new InvalidArgumentError(
        `Must be one of: ${choices.join(", ")}.${hint ? ` ${hint}` : ""}`,
      );
    }
    return value as T;
  };
}

/** Shared by both `start` driver parsers, so the two rejections read identically. */
export const START_REQUIRES_DURABLE =
  "`skein start` is the production entrypoint and requires Postgres + Redis. " +
  "For a local run with no infrastructure use `skein dev`; to point dev at production drivers, " +
  "`skein dev --store postgres --queue redis`.";

export const parseStore = parseChoice(["memory", "postgres"] as const);
export const parseQueue = parseChoice(["memory", "redis"] as const);

/**
 * `start` accepts only the durable drivers — its own parsers, deliberately not `dev`'s.
 *
 * `skein start` is the production entrypoint, and it used to *default* to the in-memory drivers: only
 * the generated Dockerfile's CMD flipped them. Any CMD override, or a hand-rolled `docker run`, quietly
 * produced a production server whose queue was process-local and whose state vanished on restart. The
 * defaults below fix the common case; rejecting the value at parse time closes the explicit-opt-in hole,
 * so `--store memory` fails with commander's allowed-values error instead of booting something that
 * cannot survive a restart.
 *
 * The flags are **kept** rather than removed: images built by older `skein build` versions pass
 * `--store postgres --queue redis` in their CMD, and dropping the flags would break every one of them.
 */
export const parseStartStore = parseChoice(["postgres"] as const, START_REQUIRES_DURABLE);
export const parseStartQueue = parseChoice(["redis"] as const, START_REQUIRES_DURABLE);
