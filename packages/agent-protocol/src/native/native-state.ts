import { SkeinHttpError, type SkeinStore } from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import { canonicalJson } from "../crypto/canonical-json.js";
import { withThreadExecution } from "../runs/thread-locks.js";
import { createProtocolServiceFromContext } from "../service.js";

function overrideReads<T extends object>(target: T, overrides: Partial<T>): T {
  // A separate facade also permits read overrides when the host froze its repository object.
  return new Proxy(Object.create(null) as T, {
    get(_facade, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
      // A third-party repository may use prototype methods and private fields. Preserve its receiver.
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has: (_facade, key) => Object.hasOwn(overrides, key) || key in target,
    ownKeys: () => [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(overrides)])],
    getOwnPropertyDescriptor: (_facade, key) => {
      const descriptor =
        Reflect.getOwnPropertyDescriptor(overrides, key) ??
        Reflect.getOwnPropertyDescriptor(target, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

async function resolveStateTarget(store: SkeinStore, threadId: string) {
  const thread = await store.threads.get(threadId);
  if (!thread) throw SkeinHttpError.notFound("Thread not found.");
  const latest = await store.runs.latestForThread(threadId);
  const assistant = latest ? await store.assistants.get(latest.assistant_id) : null;
  const assistantId = assistant
    ? latest!.assistant_id
    : typeof thread.metadata?.["graph_id"] === "string"
      ? thread.metadata["graph_id"]
      : undefined;
  return { thread, latest, assistant, assistantId };
}

/** Keep authorization, factory construction and checkpoint reading on one resolved target. */
export async function readNativeState(
  context: ProtocolContext,
  threadId: string,
  allowAssistant: (assistantId: string) => Promise<void>,
  authorize: (target: Record<string, unknown>) => Promise<ProtocolContext>,
) {
  const target = await resolveStateTarget(context.deps.store, threadId);
  if (target.assistantId) await allowAssistant(target.assistantId);
  const scoped = await authorize({
    thread_id: threadId,
    ...(target.assistantId ? { assistant_id: target.assistantId } : {}),
  });
  return withThreadExecution(
    context.executionLocks,
    context.deps.threadExecutionGate,
    threadId,
    async (leaseSignal) => {
      // Authorization can await user code. Do not build a factory for a target it did not see.
      const current = await resolveStateTarget(context.deps.store, threadId);
      if (canonicalJson(target) !== canonicalJson(current))
        throw SkeinHttpError.conflict("The state target changed; retry the read.", {
          code: "native_state_changed",
        });
      const thread = await createProtocolServiceFromContext(scoped).threads.get(threadId);
      const store = scoped.deps.store;
      // Admissions do not hold the execution lease. Freeze these lookups so a newly pending run
      // cannot change the factory after authorization; its checkpoint writes wait for this lease.
      const frozen: ProtocolContext = {
        ...scoped,
        deps: {
          ...scoped.deps,
          store: overrideReads(store, {
            threads: overrideReads(store.threads, {
              get: async (id) => (id === threadId ? thread : store.threads.get(id)),
            }),
            runs: overrideReads(store.runs, {
              latestForThread: async (id) =>
                id === threadId ? target.latest : store.runs.latestForThread(id),
            }),
            assistants: overrideReads(store.assistants, {
              get: async (id) =>
                id === target.latest?.assistant_id ? target.assistant : store.assistants.get(id),
            }),
          }),
        },
      };
      leaseSignal?.throwIfAborted();
      const state = await createProtocolServiceFromContext(frozen).threads.getState(threadId);
      leaseSignal?.throwIfAborted();
      return state;
    },
  );
}
