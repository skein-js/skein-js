import type { RunKwargs } from "@skein-js/core";

const THREAD_PROTOCOL_RUN = Symbol("thread-protocol-run");

/** Only trusted command dispatch selects protocol execution; HTTP body extras cannot. */
export function markThreadProtocolRun<T extends object>(input: T): T {
  return { ...input, [THREAD_PROTOCOL_RUN]: true };
}

export function threadProtocolKwargs(input: object): { thread_protocol?: true } {
  return THREAD_PROTOCOL_RUN in input ? { thread_protocol: true } : {};
}

export function isThreadProtocolRun(kwargs: RunKwargs): boolean {
  return "thread_protocol" in kwargs && kwargs.thread_protocol === true;
}
