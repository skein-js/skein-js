// @skein-js/runtime — assembles a `ProtocolDeps` from a `langgraph.json` plus a chosen store/queue
// driver, so `skein dev` and `skein up` boot the same engine over either in-memory or Postgres +
// Redis. See README.md and docs/storage.md.

export { buildRuntime } from "./build-runtime.js";
export type {
  BuildRuntimeOptions,
  QueueDriver,
  SkeinRuntime,
  StoreDriver,
} from "./build-runtime.js";
export { RuntimeConfigError } from "./errors.js";
export {
  resolveEmbed,
  isCustomFunctionPath,
  providerEmbedPackage,
  embedRuntimePackage,
  type ResolveEmbedOptions,
} from "./resolve-embed.js";
