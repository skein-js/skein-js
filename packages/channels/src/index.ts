// The one public surface of `@skein-js/channels`.
//
// A channel author imports from here and nowhere else — the same entry point a first-party channel
// uses. That is the rule that keeps the plugin surface honest: if a channel needs something this file
// does not export, the export is missing rather than the channel being special.

export type {
  Channel,
  ChannelOutcome,
  ChannelPrincipal,
  InboundEvent,
  InboundRequest,
  ReplyTarget,
  RunOutcomeForChannel,
  RunSignal,
  SignalSubscription,
} from "./channel/channel.js";

export { buildInboundRequest, streamModesFor } from "./channel/inbound-request.js";
export type { BuildInboundRequestOptions, RawRequest } from "./channel/inbound-request.js";

export { buildChannelRegistry } from "./channel/registry.js";
export type {
  BuildRegistryInput,
  ChannelConfig,
  ChannelRegistry,
  LoadedChannelExport,
  RegisteredChannel,
} from "./channel/registry.js";

export { channelThreadMetadata, threadIdForChannelKey } from "./channel/thread-id.js";
