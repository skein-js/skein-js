import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { ChatGoogle } from "@langchain/google/node";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";

import {
  modelProviders,
  usesApiKey,
  type ApiKeyProvider,
  type ModelConnection,
  type ModelProvider,
} from "./model-preferences.js";

const providerInput = z.enum(["vertex", "gemini", "openai", "anthropic", "ollama"]);
const preferencesInput = z.object({
  provider: providerInput,
  model: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/),
  baseUrl: z
    .string()
    .url()
    .refine((value) => {
      const endpoint = new URL(value);
      return (
        ["http:", "https:"].includes(endpoint.protocol) &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash
      );
    }, "Use an HTTP(S) server URL without credentials, query or fragment.")
    .default("http://127.0.0.1:11434"),
  project: z.string().trim().max(100).default(""),
  location: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,40}$/)
    .default("global"),
});
const connectionInput = preferencesInput.extend({
  apiKey: z.string().trim().min(1).max(1024).optional(),
});
type Preferences = z.infer<typeof preferencesInput>;

export function modelErrorMessage(error: unknown, provider?: ModelProvider): string {
  const message = error instanceof Error ? error.message : String(error);
  if (provider === "ollama") {
    if (/404|not found/i.test(message))
      return "This model is not installed in Ollama. Pull the selected model with ollama pull, then connect again.";
    return "Ollama could not finish the request. Start Ollama, check its server URL and choose an installed model that supports tools.";
  }
  const label = provider ? modelProviders[provider].label : "The model provider";
  if (/billing|prepayment|credits.*deplet|insufficient_quota/i.test(message))
    return `${label} requires available API credits or billing. Check the selected account or project in Settings.`;
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(message))
    return `${label}'s quota was reached. Check the account's quota, then try again.`;
  if (/401|403|PERMISSION_DENIED|invalid_grant|default credentials|invalid.*key/i.test(message))
    return provider === "vertex"
      ? "Vertex AI could not authenticate. Run gcloud auth application-default login and check the selected project's Vertex AI access."
      : `${label} could not authenticate. Check the API key or Google Cloud credentials in Settings.`;
  if (/404|NOT_FOUND/i.test(message))
    return `This model is unavailable for the selected provider, account or region. Check Settings.`;
  return `${label} could not finish the request. Check the connection and model in Settings, then try again.`;
}

/** Provider selection belongs to the application. Credentials never enter saved preferences or graph state. */
export function createModelSession() {
  const environment = process.env;
  const keys: Partial<Record<ApiKeyProvider, string>> = {
    gemini: environment["GOOGLE_API_KEY"] || environment["GEMINI_API_KEY"],
    openai: environment["OPENAI_API_KEY"],
    anthropic: environment["ANTHROPIC_API_KEY"],
  };
  const explicitProvider = environment["MODEL_PROVIDER"]
    ? providerInput.parse(environment["MODEL_PROVIDER"])
    : undefined;
  const inferredProvider: ModelProvider = keys.openai
    ? "openai"
    : keys.anthropic
      ? "anthropic"
      : keys.gemini
        ? "gemini"
        : environment["OLLAMA_BASE_URL"] || environment["OLLAMA_MODEL"]
          ? "ollama"
          : "vertex";
  function environmentModel(provider: ModelProvider) {
    return (
      environment["MODEL_NAME"] ||
      environment[
        provider === "openai"
          ? "OPENAI_MODEL"
          : provider === "anthropic"
            ? "ANTHROPIC_MODEL"
            : provider === "ollama"
              ? "OLLAMA_MODEL"
              : "GOOGLE_MODEL"
      ]
    );
  }
  let preferences: Preferences = preferencesInput.parse({
    provider: explicitProvider ?? inferredProvider,
    model:
      environmentModel(explicitProvider ?? inferredProvider) ??
      modelProviders[explicitProvider ?? inferredProvider].model,
    project: environment["GOOGLE_CLOUD_PROJECT"] ?? environment["GCLOUD_PROJECT"] ?? "",
    location: environment["GOOGLE_CLOUD_LOCATION"] ?? "global",
    baseUrl: environment["OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434",
  });
  let enabled = true;
  function buildModel(settings: Preferences, key?: string, maxOutputTokens = 8192) {
    if (settings.provider === "ollama")
      return new ChatOllama({
        baseUrl: settings.baseUrl,
        model: settings.model,
        numPredict: maxOutputTokens,
        checkOrPullModel: false,
        maxRetries: 0,
      });
    if (settings.provider === "anthropic") {
      if (!key) throw new Error("Enter an Anthropic API key in Settings or set ANTHROPIC_API_KEY.");
      return new ChatAnthropic({
        apiKey: key,
        model: settings.model,
        maxTokens: maxOutputTokens,
        maxRetries: 1,
      });
    }
    if (settings.provider === "openai") {
      if (!key) throw new Error("Enter an OpenAI API key in Settings or set OPENAI_API_KEY.");
      return new ChatOpenAI({
        apiKey: key,
        model: settings.model,
        maxTokens: maxOutputTokens,
        maxRetries: 1,
      });
    }
    if (settings.provider === "gemini") {
      if (!key) throw new Error("Enter a Gemini API key in Settings or set GOOGLE_API_KEY.");
      return new ChatGoogle({
        apiKey: key,
        platformType: "gai",
        model: settings.model,
        maxRetries: 1,
        maxOutputTokens,
      });
    }
    return new ChatGoogle({
      // Prevent an unrelated GOOGLE_API_KEY from selecting Vertex Express Mode.
      apiKey: "",
      platformType: "gcp",
      googleAuthOptions: { ...(settings.project ? { projectId: settings.project } : {}) },
      location: settings.location,
      model: settings.model,
      maxRetries: 1,
      maxOutputTokens,
    });
  }
  function selectedKey(provider = preferences.provider) {
    return usesApiKey(provider) ? keys[provider] : undefined;
  }
  function status(): ModelConnection {
    return {
      ...preferences,
      providerLabel: modelProviders[preferences.provider].label,
      configured:
        enabled &&
        Boolean(
          preferences.provider === "vertex"
            ? preferences.project
            : preferences.provider === "ollama"
              ? preferences.baseUrl
              : selectedKey(),
        ),
      credentialsAvailable: {
        gemini: Boolean(keys.gemini),
        openai: Boolean(keys.openai),
        anthropic: Boolean(keys.anthropic),
      },
    };
  }
  return {
    createModel() {
      if (!enabled) throw new Error("Connect a model in Settings to use the assistant.");
      return buildModel(preferences, selectedKey());
    },
    async initialize(preference?: Record<string, unknown>) {
      const saved = preferencesInput.safeParse(preference);
      const provider = explicitProvider ?? (saved.success ? saved.data.provider : inferredProvider);
      preferences = {
        provider,
        model:
          environmentModel(provider) ??
          (saved.success && saved.data.provider === provider
            ? saved.data.model
            : modelProviders[provider].model),
        project:
          environment["GOOGLE_CLOUD_PROJECT"] ??
          environment["GCLOUD_PROJECT"] ??
          (saved.success ? saved.data.project : ""),
        location:
          environment["GOOGLE_CLOUD_LOCATION"] ?? (saved.success ? saved.data.location : "global"),
        baseUrl:
          environment["OLLAMA_BASE_URL"] ??
          (saved.success ? saved.data.baseUrl : "http://127.0.0.1:11434"),
      };
      if (provider === "vertex" && !preferences.project)
        preferences.project = await new GoogleAuth().getProjectId().catch(() => "");
      // A disconnect outlives the process; otherwise an environment key would quietly reconnect it.
      enabled = preference?.["disconnected"] !== true;
      return status();
    },
    status,
    async connect(input: unknown) {
      const settings = connectionInput.parse(input);
      if (
        settings.provider === "vertex" &&
        !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(settings.project)
      )
        throw new Error("Enter your Google Cloud project ID.");
      const key = settings.apiKey ?? selectedKey(settings.provider);
      try {
        const candidate = buildModel(settings, key, 1024);
        const connection =
          settings.provider === "ollama"
            ? candidate.bindTools([
                {
                  type: "function",
                  function: {
                    name: "connection_probe",
                    description: "Check that this model accepts tool definitions.",
                    parameters: { type: "object", properties: {} },
                  },
                },
              ])
            : candidate;
        await connection.invoke([new HumanMessage("Reply with only the word Connected.")]);
      } catch (error) {
        throw new Error(modelErrorMessage(error, settings.provider));
      }
      preferences = preferencesInput.parse(settings);
      if (usesApiKey(settings.provider) && key) keys[settings.provider] = key;
      enabled = true;
      return status();
    },
    disconnect() {
      if (usesApiKey(preferences.provider)) delete keys[preferences.provider];
      enabled = false;
    },
  };
}
