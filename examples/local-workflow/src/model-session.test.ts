import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogle } from "@langchain/google/node";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createModelSession } from "./model-session.js";

beforeEach(() => {
  for (const variable of [
    "MODEL_PROVIDER",
    "MODEL_NAME",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "GOOGLE_MODEL",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
  ])
    vi.stubEnv(variable, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("honors explicit Vertex selection and the host's project without using unrelated API keys", async () => {
  vi.stubEnv("MODEL_PROVIDER", "vertex");
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "host-selected-project");
  vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
  vi.stubEnv("GOOGLE_API_KEY", "unrelated-google-key");
  vi.stubEnv("OPENAI_API_KEY", "unrelated-openai-key");
  const session = createModelSession();
  const status = await session.initialize({
    provider: "openai",
    model: "another-model",
    project: "saved-project",
    location: "global",
  });
  expect(status).toMatchObject({
    provider: "vertex",
    project: "host-selected-project",
    location: "us-central1",
    model: "gemini-3-flash-preview",
    configured: true,
  });
  expect(session.createModel()).toBeInstanceOf(ChatGoogle);
  expect(JSON.stringify(status)).not.toContain("unrelated-google-key");
  expect(JSON.stringify(status)).not.toContain("unrelated-openai-key");
});

it.each(["gemini", "openai"] as const)(
  "uses %s environment credentials and model settings",
  async (provider) => {
    vi.stubEnv(provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY", "test-environment-key");
    vi.stubEnv("MODEL_NAME", provider === "gemini" ? "gemini-3-flash-preview" : "gpt-5-mini");
    const session = createModelSession();
    expect((await session.initialize()).provider).toBe(provider);
    expect(session.status().configured).toBe(true);
    expect(session.createModel()).toBeInstanceOf(provider === "gemini" ? ChatGoogle : ChatOpenAI);
  },
);

it.each(["gemini", "openai"] as const)(
  "checks a UI-supplied %s key against the selected provider without exposing it in status",
  async (provider) => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        const response =
          provider === "gemini"
            ? {
                candidates: [
                  {
                    content: { role: "model", parts: [{ text: "Connected" }] },
                    finishReason: "STOP",
                  },
                ],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
              }
            : {
                id: "chatcmpl-test",
                object: "chat.completion",
                created: 1,
                model: "gpt-5-mini",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Connected" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              };
        return new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const session = createModelSession();
    const secret = "test-only-session-key";
    const status = await session.connect({
      provider,
      model: provider === "gemini" ? "gemini-3-flash-preview" : "gpt-5-mini",
      apiKey: secret,
    });
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(requests).toHaveLength(1);
    if (provider === "gemini") {
      expect(new URL(requests[0]!.url).hostname).toBe("generativelanguage.googleapis.com");
      expect(requests[0]!.headers.get("x-goog-api-key")).toBe(secret);
    } else {
      expect(new URL(requests[0]!.url).hostname).toBe("api.openai.com");
      expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${secret}`);
      const payload = await requests[0]!.clone().json();
      expect(payload.max_completion_tokens).toBe(1024);
      expect(payload.max_tokens).toBeUndefined();
    }
    session.disconnect();
    expect(session.status().configured).toBe(false);
    expect(session.status().credentialsAvailable[provider]).toBe(false);
    expect(() => session.createModel()).toThrow("Connect a model");
  },
);

it("keeps the working connection when a replacement key is rejected", async () => {
  vi.stubEnv("MODEL_PROVIDER", "gemini");
  vi.stubEnv("GOOGLE_API_KEY", "existing-test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Invalid API key: rejected-test-key",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    ),
  );
  const session = createModelSession();
  const previous = session.status();
  await expect(
    session.connect({ provider: "openai", model: "gpt-5-mini", apiKey: "rejected-test-key" }),
  ).rejects.toThrow("could not authenticate");
  expect(session.status()).toEqual(previous);
});

it("restores non-secret provider preferences but never reads a key from persisted preferences", async () => {
  const session = createModelSession();
  const status = await session.initialize({
    provider: "openai",
    model: "gpt-5-mini",
    project: "",
    location: "global",
    apiKey: "must-not-be-used",
  });
  expect(status).toMatchObject({ provider: "openai", configured: false });
  expect(() => session.createModel()).toThrow("OPENAI_API_KEY");
  expect(JSON.stringify(status)).not.toContain("must-not-be-used");
});

it("selects Anthropic from its environment and sends a UI key only to Anthropic", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-environment-key");
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "Connected" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  const session = createModelSession();
  expect((await session.initialize()).provider).toBe("anthropic");
  expect(session.createModel()).toBeInstanceOf(ChatAnthropic);
  const status = await session.connect({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    apiKey: "test-ui-anthropic-key",
  });
  expect(new URL(requests[0]!.url).hostname).toBe("api.anthropic.com");
  expect(requests[0]!.headers.get("x-api-key")).toBe("test-ui-anthropic-key");
  expect(JSON.stringify(status)).not.toContain("test-ui-anthropic-key");
  session.disconnect();
  expect(session.status().credentialsAvailable.anthropic).toBe(false);
});

it("uses the selected Ollama endpoint and model without forwarding a cloud key", async () => {
  vi.stubEnv("MODEL_PROVIDER", "ollama");
  vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11500");
  vi.stubEnv("OLLAMA_MODEL", "qwen3:8b");
  vi.stubEnv("OPENAI_API_KEY", "cloud-key-must-stay-private");
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return new Response(
        JSON.stringify({
          model: "qwen3:8b",
          created_at: new Date().toISOString(),
          message: { role: "assistant", content: "Connected" },
          done: true,
          done_reason: "stop",
          total_duration: 1,
          load_duration: 1,
          prompt_eval_count: 1,
          prompt_eval_duration: 1,
          eval_count: 1,
          eval_duration: 1,
        }) + "\n",
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }),
  );
  const session = createModelSession();
  await session.initialize();
  expect(session.createModel()).toBeInstanceOf(ChatOllama);
  const status = await session.connect({
    provider: "ollama",
    model: "qwen3:8b",
    baseUrl: "http://127.0.0.1:11501",
  });
  expect(status).toMatchObject({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11501",
    configured: true,
  });
  expect(new URL(requests[0]!.url).origin).toBe("http://127.0.0.1:11501");
  expect(requests[0]!.headers.get("authorization")).toBeNull();
  expect(requests[0]!.headers.get("x-api-key")).toBeNull();
  expect((await requests[0]!.clone().json()).tools[0].function.name).toBe("connection_probe");
  expect(JSON.stringify(status)).not.toContain("cloud-key-must-stay-private");
});

it("rejects credentials embedded in a persisted Ollama endpoint", async () => {
  const session = createModelSession();
  await expect(
    session.connect({
      provider: "ollama",
      model: "qwen3:8b",
      baseUrl: "http://user:private-password@localhost:11434",
    }),
  ).rejects.toThrow("without credentials");
});
