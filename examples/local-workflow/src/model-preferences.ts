export type ModelProvider = "vertex" | "gemini" | "openai" | "anthropic" | "ollama";
export type ApiKeyProvider = "gemini" | "openai" | "anthropic";
export const modelProviders = {
  vertex: { label: "Vertex AI", model: "gemini-3-flash-preview" },
  gemini: { label: "Gemini API", model: "gemini-3-flash-preview" },
  openai: { label: "OpenAI", model: "gpt-5-mini" },
  anthropic: { label: "Anthropic", model: "claude-sonnet-5-5" },
  ollama: { label: "Ollama", model: "qwen3:8b" },
} as const;
export function usesApiKey(provider: ModelProvider): provider is ApiKeyProvider {
  return provider === "gemini" || provider === "openai" || provider === "anthropic";
}
export interface ModelConnection {
  provider: ModelProvider;
  providerLabel: string;
  model: string;
  project: string;
  location: string;
  baseUrl: string;
  configured: boolean;
  credentialsAvailable: Record<ApiKeyProvider, boolean>;
  fixture?: boolean;
}
