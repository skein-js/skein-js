// @skein-js/console — the skein console: a web UI for a running skein server, compiled into this
// package as static assets and served by the server itself.
//
// The console is a *client*. It adds no protocol endpoints and holds no server-side state: every
// screen is built from the Agent Protocol surface a skein server already exposes, driven through the
// real `@langchain/langgraph-sdk`. If a view cannot be built, that is a gap in the API — see
// docs/console.md.
//
// This package ships no runtime dependencies. The SPA (React, shadcn/ui, the SDK) is compiled to
// static files at build time and embedded as string constants, so nothing here reads the filesystem
// and the package bundles cleanly into a consumer's server. See docs/bundling.md.

export { resolveConsoleAsset, consoleAssetFiles } from "./assets.js";
export type { ConsoleAsset, ResolvedConsoleAsset, ConsoleResolution } from "./assets.js";

export { resolveConsoleRequest, consoleAssetHeaders, normalizeMountPath } from "./mount.js";
export type { ConsoleMountOptions } from "./mount.js";

export { CONSOLE_ASSETS_BYTES } from "./assets.generated.js";
