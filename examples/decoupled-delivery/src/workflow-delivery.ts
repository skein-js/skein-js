import { replyWith } from "@skein-js/agent-protocol";
import type { Channel, RunOutcomeForChannel } from "@skein-js/channels";
import { z } from "zod";

const destinationEnvelopeSchema = z.object({
  destination: z.string().min(1),
  target: z.unknown(),
  payload: z.unknown(),
});

export type DestinationEnvelope = z.infer<typeof destinationEnvelopeSchema>;

export interface DestinationDelivery {
  runId: string;
  threadId: string;
  status: RunOutcomeForChannel["status"];
  interrupts: RunOutcomeForChannel["interrupts"];
  target: unknown;
  payload: unknown;
}

export interface WorkflowDestination {
  readonly name: string;
  deliver(delivery: DestinationDelivery): Promise<void>;
}

export type WorkflowSource = Pick<Channel, "name" | "verify" | "parseEvent">;

export type DestinationRegistry = ReadonlyMap<string, WorkflowDestination>;

/** Declare this run's one eventual destination without performing the external side effect here. */
export function declareDestinationDelivery(
  writer: ((chunk: unknown) => void) | undefined,
  envelope: DestinationEnvelope,
): void {
  writer?.(replyWith(destinationEnvelopeSchema.parse(envelope)));
}

/**
 * Adapt an inbound-only source to today's Channel entry point.
 *
 * The source owns neither destination routing nor credentials. Its only extra behavior is arming the
 * existing channel callback with an opaque marker, after which the graph's declared envelope chooses
 * a destination and the existing outbox invokes it durably.
 */
export function composeSourceChannel(
  source: WorkflowSource,
  destinations: DestinationRegistry,
): Channel {
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
          replyTo: { kind: "workflow-delivery" },
        },
      };
    },
    async deliver(outcome) {
      if (outcome.reply === undefined) return;
      const envelope = destinationEnvelopeSchema.parse(outcome.reply);
      const destination = destinations.get(envelope.destination);
      if (!destination) {
        throw new Error(`No workflow destination named "${envelope.destination}" is configured.`);
      }
      await destination.deliver({
        runId: outcome.runId,
        threadId: outcome.threadId,
        status: outcome.status,
        interrupts: outcome.interrupts,
        target: envelope.target,
        payload: envelope.payload,
      });
    },
  };
}
