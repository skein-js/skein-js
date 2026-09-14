import { replyWith } from "@skein-js/agent-protocol";
import { SkeinConfigError } from "@skein-js/config/errors";
import { z } from "zod";

import type { Channel, RunOutcomeForChannel } from "../channel/channel.js";

const DESTINATION_MARKER = "$skein_channel_destination";

const jsonValueSchema = z.unknown().transform((value, context) => {
  const snapshot = snapshotJsonValue(value);
  if (snapshot.valid) return snapshot.value;
  context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a JSON-persistable value." });
  return z.NEVER;
});

const destinationIntentSchema = z
  .object({
    destination: z.string().refine((name) => name.trim().length > 0, {
      message: "A channel destination name cannot be empty.",
    }),
    target: jsonValueSchema,
    payload: jsonValueSchema,
  })
  .strict();

const destinationDeclarationSchema = z
  .object({
    [DESTINATION_MARKER]: z
      .object({
        version: z.literal(1),
        intent: destinationIntentSchema,
      })
      .strict(),
  })
  .strict();

export interface ChannelDestinationIntent {
  destination: string;
  target: unknown;
  payload: unknown;
}

export interface ChannelDestinationDelivery {
  runId: string;
  threadId: string;
  status: RunOutcomeForChannel["status"];
  interrupts?: RunOutcomeForChannel["interrupts"];
  target: unknown;
  payload: unknown;
}

type ChannelSource = Pick<Channel, "name" | "verify" | "parseEvent">;
type DestinationCallback = (delivery: ChannelDestinationDelivery) => Promise<void>;

/** Declare one graph-selected delivery without performing its external side effect in the graph. */
export function declareChannelDestinationDelivery(
  writer: ((chunk: unknown) => void) | undefined,
  intent: ChannelDestinationIntent,
): void {
  const parsedIntent = destinationIntentSchema.parse(intent);
  writer?.(
    replyWith({
      [DESTINATION_MARKER]: { version: 1, intent: parsedIntent },
    }),
  );
}

/** Adapt an inbound-only source and an application-owned destination map to the existing Channel. */
export function composeRoutedChannel(
  source: ChannelSource,
  destinations: ReadonlyMap<string, DestinationCallback>,
): Channel {
  assertSource(source);
  const destinationSnapshot = snapshotDestinations(destinations);

  return {
    name: source.name,
    verify: (request) => source.verify(request),
    async parseEvent(request) {
      const outcome = await source.parseEvent(request);
      if (outcome.kind !== "event") return outcome;
      return {
        kind: "event",
        event: {
          ...outcome.event,
          replyTo: outcome.event.replyTo ?? null,
        },
      };
    },
    async deliver(outcome) {
      const intent = readDestinationIntent(outcome.reply);
      if (!intent) return;
      const destination = destinationSnapshot.get(intent.destination);
      if (!destination) {
        throw new Error(`No channel destination named "${intent.destination}" is configured.`);
      }
      await destination({
        runId: outcome.runId,
        threadId: outcome.threadId,
        status: outcome.status,
        ...(outcome.interrupts ? { interrupts: outcome.interrupts } : {}),
        target: intent.target,
        payload: intent.payload,
      });
    },
  };
}

function readDestinationIntent(reply: unknown): ChannelDestinationIntent | undefined {
  if (
    typeof reply !== "object" ||
    reply === null ||
    !Object.prototype.hasOwnProperty.call(reply, DESTINATION_MARKER)
  ) {
    return undefined;
  }
  const parsed = destinationDeclarationSchema.parse(reply)[DESTINATION_MARKER].intent;
  return {
    destination: parsed.destination,
    target: parsed.target,
    payload: parsed.payload,
  };
}

function snapshotDestinations(
  destinations: ReadonlyMap<string, DestinationCallback>,
): ReadonlyMap<string, DestinationCallback> {
  const snapshot = new Map<string, DestinationCallback>();
  for (const [name, destination] of destinations) {
    if (name.trim().length === 0)
      throw new SkeinConfigError("A channel destination name cannot be empty.");
    if (typeof destination !== "function") {
      throw new SkeinConfigError(`Channel destination "${name}" must be a function.`);
    }
    snapshot.set(name, destination);
  }
  return snapshot;
}

function assertSource(source: ChannelSource): void {
  if (typeof source.name !== "string" || source.name.trim().length === 0) {
    throw new SkeinConfigError("A routed channel source must have a non-empty name.");
  }
  if (typeof source.verify !== "function" || typeof source.parseEvent !== "function") {
    throw new SkeinConfigError("A routed channel source must implement verify and parseEvent.");
  }
}

type JsonSnapshot =
  null | string | boolean | number | JsonSnapshot[] | { [key: string]: JsonSnapshot };

type JsonSnapshotResult = { valid: true; value: JsonSnapshot } | { valid: false; value?: never };

/** Validate and copy once, so later caller mutation cannot change an already-declared delivery. */
function snapshotJsonValue(value: unknown, ancestors = new Set<object>()): JsonSnapshotResult {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { valid: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { valid: true, value } : { valid: false };
  }
  if (typeof value !== "object" || ancestors.has(value)) return { valid: false };

  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return { valid: false };
    if (Array.isArray(value)) {
      // `Array#every` skips holes, but JSON serialization turns them into `null`. Reject that silent
      // shape change, along with enumerable properties that are not array elements.
      if (Object.keys(value).length !== value.length) return { valid: false };
      const snapshot: JsonSnapshot[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return { valid: false };
        const entry = snapshotJsonValue(value[index], ancestors);
        if (!entry.valid) return entry;
        snapshot.push(entry.value);
      }
      return { valid: true, value: snapshot };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { valid: false };
    const entries: Array<[string, JsonSnapshot]> = [];
    for (const [key, candidate] of Object.entries(value)) {
      const entry = snapshotJsonValue(candidate, ancestors);
      if (!entry.valid) return entry;
      entries.push([key, entry.value]);
    }
    // `Object.fromEntries` defines `__proto__` as data instead of invoking its legacy setter.
    return { valid: true, value: Object.fromEntries(entries) };
  } catch {
    return { valid: false };
  } finally {
    ancestors.delete(value);
  }
}
