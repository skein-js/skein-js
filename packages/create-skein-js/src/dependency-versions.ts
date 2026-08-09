// The single source of truth for every third-party version range a scaffolded project pins, and for
// everything that differs between model providers.
//
// The ranges are deliberately identical to the ones the runnable examples use, because the examples
// are typechecked in CI and are what the docs link to — they are the live proof that this
// combination of versions actually works together. `dependency-versions.test.ts` reads
// `examples/express-basic/package.json` and fails when the two drift, so bumping an example without
// bumping the scaffolder breaks a test instead of quietly shipping a stale starter.
//
// `skein-js` and `@skein-js/*` are NOT here: they come from resolveSkeinVersionRange(), which
// derives them from this package's own version.

import type { ModelProvider } from "./scaffold-options.js";

/** Ranges every scaffolded project pins. */
export const CORE_VERSIONS = {
  "@langchain/core": "^1.2.0",
  "@langchain/langgraph": "^1.4.0",
  "@langchain/langgraph-sdk": "^1.9.0",
  zod: "^3.25.32",
} as const;

/** Toolchain ranges for the generated project's devDependencies. Tracks the workspace root. */
export const TOOLCHAIN_VERSIONS = {
  "@types/node": "^22.10.0",
  typescript: "^5.7.2",
  vitest: "^4.1.9",
} as const;

/** Everything that varies by model provider: the package, the class, and the env it reads. */
export interface ProviderDetails {
  /** npm package the agent graph imports the model class from. */
  readonly packageName: string;
  /** Range to pin that package at. */
  readonly versionRange: string;
  /** The chat-model class exported by it. */
  readonly modelClass: string;
  /** The credential the model client looks for. */
  readonly apiKeyEnvVar: string;
  /** Where a reader gets that credential. */
  readonly consoleUrl: string;
  /** Env var the generated graph reads to override the model. */
  readonly modelEnvVar: string;
  /** Model used when that override is unset. */
  readonly defaultModel: string;
}

// Default models are the current mid-tier model from each provider — the one their own docs
// recommend for agents that call tools, which is exactly what the scaffolded agent graph does.
// Verified against each provider's live model list on 2026-08-09; a stale ID here means every
// scaffolded agent 404s on its first real request, so re-check these when bumping a provider
// package rather than assuming the string still resolves.
export const PROVIDER_DETAILS: Record<Exclude<ModelProvider, "none">, ProviderDetails> = {
  google: {
    packageName: "@langchain/google-genai",
    versionRange: "^2.2.0",
    modelClass: "ChatGoogleGenerativeAI",
    apiKeyEnvVar: "GOOGLE_API_KEY",
    consoleUrl: "https://aistudio.google.com/apikey",
    modelEnvVar: "GOOGLE_MODEL",
    defaultModel: "gemini-3.6-flash",
  },
  anthropic: {
    packageName: "@langchain/anthropic",
    versionRange: "^1.5.4",
    modelClass: "ChatAnthropic",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    modelEnvVar: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-5",
  },
  openai: {
    packageName: "@langchain/openai",
    versionRange: "^1.5.6",
    modelClass: "ChatOpenAI",
    apiKeyEnvVar: "OPENAI_API_KEY",
    consoleUrl: "https://platform.openai.com/api-keys",
    modelEnvVar: "OPENAI_MODEL",
    defaultModel: "gpt-5.6-terra",
  },
};
