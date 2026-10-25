import { isSkeinHttpError, SkeinHttpError, type Checkpoint, type RunKwargs } from "@skein-js/core";

import type { ResolvedDeps } from "../deps.js";
import { verifyResumeTarget } from "../runs/resume-target.js";

interface A2aOrigin {
  rootId?: string;
  expectedRunId?: string;
  checkpoint?: Checkpoint;
}
const A2A_ORIGIN = Symbol("a2a-origin");
const bodies = new WeakMap<object, A2aOrigin>();

export function markA2aBody<T extends object>(body: T, origin: A2aOrigin): T {
  bodies.set(body, origin);
  return body;
}
export function transferA2aOrigin<T extends object>(body: unknown, parsed: T): T {
  const origin = typeof body === "object" && body !== null ? bodies.get(body) : undefined;
  return origin ? { ...parsed, [A2A_ORIGIN]: origin } : parsed;
}
export function a2aKwargs(input: object): { a2a_origin?: A2aOrigin } {
  return A2A_ORIGIN in input ? { a2a_origin: input[A2A_ORIGIN] as A2aOrigin } : {};
}
export function readA2aOrigin(kwargs: RunKwargs | null): A2aOrigin | undefined {
  return kwargs && "a2a_origin" in kwargs ? (kwargs.a2a_origin as A2aOrigin) : undefined;
}

/** Called while the existing thread execution lease is held, before any graph invocation. */
export async function verifyA2aResume(
  deps: ResolvedDeps,
  threadId: string,
  runId: string,
  origin?: A2aOrigin,
): Promise<void> {
  if (!origin?.expectedRunId) return;
  try {
    await verifyResumeTarget(deps, threadId, runId, origin);
  } catch (cause) {
    if (isSkeinHttpError(cause) && cause.code === "stale_resume")
      throw SkeinHttpError.conflict("A2A task no longer owns the interrupted checkpoint.", {
        cause,
      });
    throw cause;
  }
}
