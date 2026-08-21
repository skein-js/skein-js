// Loads the channel modules a `langgraph.json` names in `skein.channels`.
//
// This file resolves and imports; it does not validate that what came back is a channel. That check
// lives in `@skein-js/channels`, which owns the contract — typing it here would make every consumer of
// `@skein-js/config` depend on the channels package to name a type, and channels would stop being
// optional. So the module comes back as `unknown` and the registry proves it.

import { pathToFileURL } from "node:url";

import { SkeinConfigError } from "./errors.js";
import { parseGraphSpec, type ModuleImporter } from "./graph-spec.js";
import type { ChannelsJsonConfig } from "./langgraph-json.js";

/** Where and how to load channel modules — the same importer seam graphs and `auth.path` use. */
export interface LoadChannelsOptions {
  /** Directory the `path` specs are resolved against (the `langgraph.json` location). */
  configDir: string;
  /** Module importer (native ESM by default; `skein dev` injects the vite-backed one). */
  importModule?: ModuleImporter;
}

/** One loaded channel: the module's export, plus the config it was mounted with. */
export interface LoadedChannel {
  /** Unvalidated — `buildChannelRegistry` decides whether this is really a channel. */
  module: unknown;
  assistant: string;
  allowedAssistants?: readonly string[];
  publicUrl?: string;
}

/**
 * Import every configured channel, keyed by name.
 *
 * A bare package name (`@skein-js/channel-twilio`) is imported as a package; anything else is a
 * `path:export` spec resolved against `configDir`, exactly as graphs are. Both are supported because
 * a channel is equally likely to be a published adapter or a file in your own repo — the latter being
 * the case that proves the plugin surface is real.
 */
export async function loadChannels(
  channels: ChannelsJsonConfig,
  options: LoadChannelsOptions,
): Promise<Record<string, LoadedChannel>> {
  if (!channels) return {};
  const importModule =
    options.importModule ??
    ((sourceFile: string) =>
      import(pathToFileURL(sourceFile).href) as Promise<Record<string, unknown>>);

  const loaded: Record<string, LoadedChannel> = {};
  for (const [name, config] of Object.entries(channels)) {
    loaded[name] = {
      module: await importChannelModule(name, config.path, options.configDir, importModule),
      assistant: config.assistant,
      ...(config.allowed_assistants ? { allowedAssistants: config.allowed_assistants } : {}),
      ...(config.public_url ? { publicUrl: config.public_url } : {}),
    };
  }
  return loaded;
}

async function importChannelModule(
  name: string,
  spec: string,
  configDir: string,
  importModule: ModuleImporter,
): Promise<unknown> {
  if (isBarePackageSpecifier(spec)) {
    try {
      const module = (await import(spec)) as Record<string, unknown>;
      return module["channel"] ?? module["default"] ?? module;
    } catch (cause) {
      throw new SkeinConfigError(
        `skein.channels.${name}.path is "${spec}", which could not be imported. Is it installed?`,
        { cause },
      );
    }
  }

  const { sourceFile, exportSymbol } = parseGraphSpec(spec, configDir);
  let module: Record<string, unknown>;
  try {
    module = await importModule(sourceFile);
  } catch (cause) {
    throw new SkeinConfigError(
      `skein.channels.${name}.path points at "${sourceFile}", which could not be imported.`,
      { cause },
    );
  }
  // Reported here rather than left to the registry's structural check, because "the file loaded but
  // has no such export" and "the export is not a channel" are different mistakes with different
  // fixes, and the second message would send you looking at the wrong thing.
  if (!(exportSymbol in module)) {
    const available = Object.keys(module).join(", ") || "none";
    throw new SkeinConfigError(
      `skein.channels.${name}.path names export "${exportSymbol}", which "${sourceFile}" does not ` +
        `export (available: ${available}).`,
    );
  }
  return module[exportSymbol];
}

/**
 * A package specifier rather than a file path — `twilio-channel`, `@scope/name`, `@scope/name/sub`.
 *
 * Anything relative or absolute is a path. Mirrors how Node itself decides, so a channel published to
 * npm and a channel in your own repo are configured the same way.
 */
function isBarePackageSpecifier(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(spec);
}
