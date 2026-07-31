import type { LanggraphJson, SkeinRuntimeName } from "@skein-js/config";

export const DEFAULT_RUNTIME_VERSIONS: Readonly<Record<SkeinRuntimeName, string>> = {
  node: "24",
  bun: "1.3.14",
  deno: "2.9.4",
};

export interface RuntimeSelectionOptions {
  runtime?: SkeinRuntimeName;
  runtimeVersion?: string;
}

export interface ResolvedRuntimeSelection {
  name: SkeinRuntimeName;
  version: string;
}

/** Resolve CLI → `skein.runtime` → defaults, preserving legacy `node_version` for Node. */
export function resolveRuntimeSelection(
  config: LanggraphJson,
  options: RuntimeSelectionOptions = {},
): ResolvedRuntimeSelection {
  const name = options.runtime ?? config.skein?.runtime?.name ?? "node";
  const configuredVersion =
    config.skein?.runtime?.name === name ? config.skein.runtime.version : undefined;
  const legacyNodeVersion = name === "node" ? config.node_version : undefined;
  return {
    name,
    version:
      options.runtimeVersion ??
      configuredVersion ??
      legacyNodeVersion ??
      DEFAULT_RUNTIME_VERSIONS[name],
  };
}
