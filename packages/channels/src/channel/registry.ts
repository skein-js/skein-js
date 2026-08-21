// The configured channels, validated once at boot rather than at the first inbound event.

import { SkeinConfigError } from "@skein-js/config/errors";

import type { Channel } from "./channel.js";

/** One channel's deployment-side configuration — the `skein.channels.<name>` block. */
export interface ChannelConfig {
  /**
   * Which graph this channel's events run.
   *
   * **Required**, and deliberately not something a channel can default. The binding is deployment
   * knowledge: a community Twilio adapter has no business knowing you named your graph `support`.
   */
  assistant: string;
  /**
   * Graphs a channel may route to via `InboundEvent.assistantId`. Omitted means it cannot route at all.
   *
   * Opt-in and bounded, because a channel is an npm package someone installed: without this an
   * unbounded `assistantId` would let any published channel direct untrusted input into any graph.
   */
  allowedAssistants?: readonly string[];
  /** The externally reachable origin, when signatures cover the URL. See `buildInboundRequest`. */
  publicUrl?: string;
}

/** A channel plus the configuration it was mounted with. */
export interface RegisteredChannel {
  readonly channel: Channel;
  readonly config: ChannelConfig;
}

export interface ChannelRegistry {
  /** The configured names, for building the route table. */
  readonly names: readonly string[];
  get(name: string): RegisteredChannel | undefined;
}

/**
 * Anything a `path:export` might have produced, before it has been proven to be a channel.
 *
 * `unknown` rather than `Channel` on purpose: the loader lives in `@skein-js/config`, and typing it as
 * a channel there would make every config consumer depend on this package to name the type — which
 * would stop channels being optional.
 */
export type LoadedChannelExport = unknown;

export interface BuildRegistryInput {
  /** Loaded exports keyed by channel name, plus the config each was mounted with. */
  readonly channels: Readonly<
    Record<string, { module: LoadedChannelExport; config: ChannelConfig }>
  >;
  /** Graph ids the deployment serves, for validating `assistant` and `allowedAssistants`. */
  readonly graphIds: readonly string[];
}

/**
 * Validate every configured channel and return the registry the pipeline reads.
 *
 * **Everything is checked here, at boot, not at the first event.** Discovering that `assistant` names
 * a graph that does not exist when the first customer texts is precisely the failure this avoids, and
 * it is the kind of typo that only shows up in production because nothing else reads the key.
 */
export function buildChannelRegistry(input: BuildRegistryInput): ChannelRegistry {
  const registered = new Map<string, RegisteredChannel>();

  for (const [name, { module, config }] of Object.entries(input.channels)) {
    const channel = asChannel(module, name);

    if (!config.assistant) {
      throw configError(
        `skein.channels.${name} has no "assistant" — name the graph its events run.`,
      );
    }
    // A UUID is allowed through unchecked: it addresses an assistant created over the API, which does
    // not exist yet at boot. A name, though, has to match a graph we actually serve.
    if (!isUuid(config.assistant) && !input.graphIds.includes(config.assistant)) {
      throw configError(
        `skein.channels.${name}.assistant is "${config.assistant}", which is not one of this ` +
          `deployment's graphs (${input.graphIds.join(", ") || "none"}).`,
      );
    }
    for (const allowed of config.allowedAssistants ?? []) {
      if (!isUuid(allowed) && !input.graphIds.includes(allowed)) {
        throw configError(
          `skein.channels.${name}.allowed_assistants names "${allowed}", which is not one of this ` +
            `deployment's graphs.`,
        );
      }
    }
    if (config.publicUrl !== undefined) {
      try {
        new URL(config.publicUrl);
      } catch {
        throw configError(
          `skein.channels.${name}.public_url is "${config.publicUrl}", which is not an absolute URL.`,
        );
      }
    }

    registered.set(name, { channel, config });
  }

  return {
    names: [...registered.keys()],
    get: (name) => registered.get(name),
  };
}

/**
 * Prove a loaded export is a channel.
 *
 * Structural rather than an `instanceof`, because a channel is a plain object a third party wrote and
 * there is no base class to inherit. The two required methods are exactly the two provider-specific
 * steps — everything else the pipeline supplies — so their absence is what distinguishes a channel
 * from any other module someone pointed the config at.
 */
function asChannel(module: LoadedChannelExport, name: string): Channel {
  const candidate = module as Partial<Channel> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.verify !== "function" ||
    typeof candidate.parseEvent !== "function"
  ) {
    throw configError(
      `skein.channels.${name}.path does not export a channel — it must have \`verify\` and ` +
        `\`parseEvent\` functions.`,
    );
  }
  // **Not** `{ ...candidate }`. A spread copies own enumerable properties only, so a channel written
  // as a class passes the checks above (its methods live on the prototype and `typeof` finds them)
  // and then throws `channel.verify is not a function` on the first real request. Naming it without
  // copying keeps every shape working — object literal, class instance, or something returned by a
  // factory.
  if (candidate.name === undefined) {
    Object.defineProperty(candidate, "name", { value: name, enumerable: true, configurable: true });
  }
  return candidate as Channel;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * A boot failure, not a request failure — the same class every other bad `langgraph.json` raises, so
 * an operator sees one error type for configuration problems rather than one per feature.
 */
function configError(message: string): Error {
  return new SkeinConfigError(message);
}
