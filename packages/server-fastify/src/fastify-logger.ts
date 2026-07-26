// Bridge skein's `Logger` onto Fastify's `log` (pino), so a failed graph run lands in the host app's
// log stream as a proper structured record.
//
// This is `skeinPlugin`'s default, and defaulting it on is safe for the same reason it is under
// NestJS: `fastify.log` is the host's own logger, configured by the host — `Fastify({ logger: false })`
// yields an abstract no-op and skein stays silent. Skein borrows the decision rather than making it.
//
// Unlike the NestJS bridge, meta is NOT flattened to text. Pino is object-first (`log.error(obj, msg)`),
// and flattening would destroy exactly what makes a record queryable — `err` gets pino's error
// serializer, and a failed run's ids become fields you can filter on.

import { isRunFailureReport, type Logger } from "@skein-js/agent-protocol";
import type { FastifyBaseLogger } from "fastify";

/** Pino's conventional bindings for a value skein passes as `meta`. */
function toBindings(meta: unknown): Record<string, unknown> | undefined {
  if (meta === undefined || meta === null) return undefined;
  if (isRunFailureReport(meta)) {
    return {
      // `err` is the key pino's standard error serializer looks for — it expands the message, type,
      // stack and `cause` chain, so the failure's full story survives into the record.
      err: meta.error,
      // Discrete fields rather than server-kit's `runFailureIdentity` string: the whole point of a
      // structured sink is that these stay filterable. The empty-`failingNodes` rule is shared with
      // it, though — omitted, never an empty array to filter around.
      run_id: meta.runId,
      thread_id: meta.threadId,
      assistant_id: meta.assistantId,
      ...(meta.failingNodes.length > 0 ? { failing_nodes: meta.failingNodes } : {}),
    };
  }
  if (meta instanceof Error) return { err: meta };
  if (typeof meta === "object") return meta as Record<string, unknown>;
  // A primitive can't be spread into bindings; give it a field rather than dropping it.
  return { detail: meta };
}

/**
 * A skein `Logger` that writes through a Fastify/pino logger.
 *
 * ```ts
 * await app.register(skeinPlugin, { config: "./langgraph.json" }); // uses app.log by default
 * ```
 *
 * Pass one explicitly to write somewhere else — `createFastifyLogger(app.log.child({ svc: "graphs" }))`.
 */
export function createFastifyLogger(log: FastifyBaseLogger): Logger {
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, meta?: unknown): void => {
      const bindings = toBindings(meta);
      // Called through `log` rather than destructured, so pino keeps its `this` binding.
      if (bindings) log[level](bindings, message);
      else log[level](message);
    };

  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
