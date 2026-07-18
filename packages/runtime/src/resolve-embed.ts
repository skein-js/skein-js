// Resolve a `langgraph.json` `store.index.embed` value into an `EmbedFunction`, matching the two
// forms the LangGraph CLI documents (docs.langchain.com/langsmith/cli):
//
//   1. A custom-function path — `"./embeddings.ts:embed"` — whose export is either a raw
//      `(texts: string[]) => number[][]` (the exact shape LangGraph documents) or a LangChain
//      `Embeddings` instance. This is the JS-idiomatic form; we reuse config's `path:export` loader.
//   2. A `"provider:model"` string — `"openai:text-embedding-3-small"`. LangChain.js has no
//      `initEmbeddings` (only Python does), and the JS langgraph-api never resolves this itself, so
//      we mirror Python `init_embeddings`' algorithm: split the provider prefix, dynamically import
//      the matching `@langchain/<provider>` package (an optional dep), and instantiate its
//      `Embeddings` class. `Embeddings.embedDocuments` already matches our `EmbedFunction`.

import { pathToFileURL } from "node:url";

import { parseGraphSpec, type ModuleImporter } from "@skein-js/config";
import type { EmbedFunction } from "@skein-js/storage-postgres";

import { RuntimeConfigError } from "./errors.js";

/** A minimal `@langchain/core` `Embeddings` shape — all we need to compute batch embeddings. */
interface EmbeddingsLike {
  embedDocuments(texts: string[]): Promise<number[][]>;
}
type EmbeddingsConstructor = new (fields: { model: string }) => EmbeddingsLike;

/** Provider prefix → the package + named export that provides its `Embeddings` class. */
interface ProviderEntry {
  package: string;
  exportName: string;
}
const PROVIDERS: Record<string, ProviderEntry> = {
  openai: { package: "@langchain/openai", exportName: "OpenAIEmbeddings" },
  azure_openai: { package: "@langchain/openai", exportName: "AzureOpenAIEmbeddings" },
  cohere: { package: "@langchain/cohere", exportName: "CohereEmbeddings" },
  google_genai: { package: "@langchain/google-genai", exportName: "GoogleGenerativeAIEmbeddings" },
  mistralai: { package: "@langchain/mistralai", exportName: "MistralAIEmbeddings" },
  bedrock: { package: "@langchain/aws", exportName: "BedrockEmbeddings" },
  ollama: { package: "@langchain/ollama", exportName: "OllamaEmbeddings" },
};

export interface ResolveEmbedOptions {
  /** Directory holding `langgraph.json`, used to resolve a custom-function path. */
  configDir: string;
  /** TS-capable importer (the CLI's vite loader) for a custom-function `.ts` path. */
  importModule?: ModuleImporter;
}

/** Adapt a resolved export — a raw embed function or a LangChain `Embeddings` — to `EmbedFunction`. */
function toEmbedFunction(value: unknown, source: string): EmbedFunction {
  if (typeof value === "function") {
    return value as EmbedFunction;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "embedDocuments" in value &&
    typeof (value as EmbeddingsLike).embedDocuments === "function"
  ) {
    const embeddings = value as EmbeddingsLike;
    return (texts) => embeddings.embedDocuments(texts);
  }
  throw new RuntimeConfigError(
    `store.index.embed "${source}" must resolve to a function (texts: string[]) => number[][] ` +
      `or a LangChain Embeddings instance.`,
  );
}

/**
 * Whether a `store.index.embed` value is a custom-function path (`"./embed.ts:fn"`) rather than a
 * `"provider:model"` string — it looks like a path (starts with `.`/`/`) or names a source file.
 * Exported so `skein build` knows which embed forms to bundle (paths) vs leave as provider strings.
 */
export function isCustomFunctionPath(embed: string): boolean {
  const head = embed.split(":", 1)[0] ?? "";
  return head.startsWith(".") || head.startsWith("/") || /\.([mc]?[jt]s|py)$/.test(head);
}

/**
 * The npm package a `store.index.embed` value needs **installed at runtime**, or undefined. A
 * `provider:model` embed dynamically imports `@langchain/<provider>` (see {@link resolveProviderEmbed}),
 * but that package is never imported by graph code, so `skein build` won't discover it while bundling —
 * it must pin this package into the production image explicitly. Custom-function paths return undefined
 * (they are bundled), as do unknown providers.
 */
export function providerEmbedPackage(embed: string): string | undefined {
  if (isCustomFunctionPath(embed)) return undefined;
  const separator = embed.indexOf(":");
  if (separator === -1) return undefined;
  return PROVIDERS[embed.slice(0, separator)]?.package;
}

/**
 * @deprecated Renamed to {@link providerEmbedPackage} — it returns the npm package a `provider:model`
 * embed needs installed, not a verb. Kept for back-compat; slated for removal in a future major.
 */
export const embedRuntimePackage = providerEmbedPackage;

/** Resolve form (1): load `sourceFile`'s `exportSymbol` and adapt it to an `EmbedFunction`. */
async function resolvePathEmbed(
  embed: string,
  options: ResolveEmbedOptions,
): Promise<EmbedFunction> {
  const { sourceFile, exportSymbol } = parseGraphSpec(embed, options.configDir);
  const importer: ModuleImporter =
    options.importModule ??
    ((file) => import(pathToFileURL(file).href) as Promise<Record<string, unknown>>);
  const module = await importer(sourceFile);
  const exported = module[exportSymbol];
  if (exported === undefined) {
    throw new RuntimeConfigError(
      `store.index.embed "${embed}" — module "${sourceFile}" has no export "${exportSymbol}".`,
    );
  }
  return toEmbedFunction(exported, embed);
}

/** Resolve form (2): dynamically import the provider package and instantiate its `Embeddings`. */
async function resolveProviderEmbed(provider: string, model: string): Promise<EmbedFunction> {
  const entry = PROVIDERS[provider];
  if (!entry) {
    throw new RuntimeConfigError(
      `Unknown embeddings provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(", ")}. ` +
        `Or point store.index.embed at a "./path:export" custom embedder.`,
    );
  }
  let module: Record<string, unknown>;
  try {
    module = (await import(entry.package)) as Record<string, unknown>;
  } catch {
    throw new RuntimeConfigError(
      `store.index.embed uses "${provider}:", so install ${entry.package} in your project ` +
        `(and set the provider's API key).`,
    );
  }
  const EmbeddingsClass = module[entry.exportName];
  if (typeof EmbeddingsClass !== "function") {
    throw new RuntimeConfigError(`${entry.package} does not export "${entry.exportName}".`);
  }
  const embeddings = new (EmbeddingsClass as EmbeddingsConstructor)({ model });
  return (texts) => embeddings.embedDocuments(texts);
}

/** Resolve a `store.index.embed` value to an `EmbedFunction`, honoring both LangGraph forms. */
export async function resolveEmbed(
  embed: string,
  options: ResolveEmbedOptions,
): Promise<EmbedFunction> {
  if (isCustomFunctionPath(embed)) {
    return resolvePathEmbed(embed, options);
  }
  const separator = embed.indexOf(":");
  if (separator === -1) {
    throw new RuntimeConfigError(
      `store.index.embed "${embed}" must be "provider:model" (e.g. "openai:text-embedding-3-small") ` +
        `or a "./path:export" custom embedder.`,
    );
  }
  return resolveProviderEmbed(embed.slice(0, separator), embed.slice(separator + 1));
}
