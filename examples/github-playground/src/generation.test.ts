import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { streamGitHubUi } from "./index.js";

const request = {
  modelSetting: "JSON_RENDER_MODEL",
  prompt: "Show example/project",
  previousUi: null,
  systemPrompt: "Write the UI",
} as const;

const repoCall = {
  functionCall: { name: "get_github_repository", args: { owner: "example", name: "project" } },
};

function modelResponse(parts: object[]) {
  return { candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }] };
}

async function collectUi(signal?: AbortSignal) {
  let ui = "";
  for await (const text of streamGitHubUi({ ...request, signal })) ui += text;
  return ui;
}

beforeEach(() => {
  vi.stubEnv("JSON_RENDER_MODEL", "google:gemini-test");
  vi.stubEnv("GOOGLE_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("passes cleaned tool facts to the renderer and streams only the UI", async () => {
  let generationPrompt = "";

  const fetchRequest = vi.fn(async (input: string | URL | Request) => {
    if (!(input instanceof Request))
      return Response.json({
        full_name: "example/project",
        description: "lookup-only sentinel",
        language: "TypeScript",
        stargazers_count: 34567,
        forks_count: 321,
        default_branch: "main",
        pushed_at: "2025-01-01T12:00:00Z",
        private_field: "unused metadata",
      });
    if (input.url.includes(":generateContent")) return Response.json(modelResponse([repoCall]));
    generationPrompt = await input.text();
    return new Response(`data: ${JSON.stringify(modelResponse([{ text: "rendered UI" }]))}\n\n`);
  });
  vi.stubGlobal("fetch", fetchRequest);

  const host = new StateGraph(new StateSchema({ ui: z.string().default("") }))
    .addNode("generate", async (_, config) => {
      const ui = await collectUi(config.signal);
      config.writer?.({ ui });
      return { ui };
    })
    .addEdge(START, "generate")
    .addEdge("generate", END)
    .compile();

  const events = [];
  for await (const event of await host.stream(
    {},
    { streamMode: ["custom", "values"], subgraphs: true },
  ))
    events.push(event);

  expect(
    fetchRequest.mock.calls.map(([input]) =>
      String(input instanceof Request ? new URL(input.url).hostname : input),
    ),
  ).toContain("https://api.github.com/repos/example/project");
  expect(generationPrompt).toContain("34567");
  expect(generationPrompt).toContain("lookup-only sentinel");
  expect(generationPrompt).not.toContain("unused metadata");
  expect(events).toContainEqual([[], "custom", { ui: "rendered UI" }]);
  expect(JSON.stringify(events)).not.toMatch(/lookup-only sentinel|34567|tool_calls/);
});

it.each([
  [404, "could not find that public resource"],
  [429, "public API rate limit"],
] as const)("gives the model a safe message for GitHub status %i", async (status, message) => {
  let generationPrompt = "";
  vi.stubGlobal("fetch", async (input: URL | Request) => {
    if (input instanceof URL) return new Response("upstream body", { status });
    if (input.url.includes(":generateContent")) return Response.json(modelResponse([repoCall]));
    generationPrompt = await input.text();
    return new Response(
      `data: ${JSON.stringify(modelResponse([{ text: "lookup error UI" }]))}\n\n`,
    );
  });
  expect(await collectUi()).toBe("lookup error UI");
  expect(generationPrompt).toContain(message);
  expect(generationPrompt).not.toContain("upstream body");
});

it("rejects an oversized tool batch before contacting GitHub", async () => {
  const fetchRequest = vi.fn(() =>
    Response.json(modelResponse(Array.from({ length: 6 }, () => repoCall))),
  );
  vi.stubGlobal("fetch", fetchRequest);
  await expect(collectUi()).rejects.toThrow("at most five GitHub lookups");
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});

it("cancels a GitHub fetch with the parent run", async () => {
  let githubSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", (input: URL | Request, init?: RequestInit) => {
    if (input instanceof Request) return Response.json(modelResponse([repoCall]));
    githubSignal = init?.signal ?? undefined;
    return new Promise<Response>((_, reject) => {
      githubSignal?.addEventListener("abort", () => reject(githubSignal?.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const result = collectUi(controller.signal);
  await vi.waitFor(() => expect(githubSignal).toBeDefined());
  const rejected = expect(result).rejects.toThrow(/abort/i);
  controller.abort();
  await rejected;
  expect(githubSignal?.aborted).toBe(true);
});

it("requires model configuration before it attempts a lookup", async () => {
  vi.stubEnv("JSON_RENDER_MODEL", undefined);
  const fetchRequest = vi.fn();
  vi.stubGlobal("fetch", fetchRequest);
  await expect(collectUi()).rejects.toThrow("Set JSON_RENDER_MODEL");
  expect(fetchRequest).not.toHaveBeenCalled();
});

it.each([undefined, "   "])("rejects a missing or blank Gemini key (%j)", async (apiKey) => {
  vi.stubEnv("GOOGLE_API_KEY", apiKey);
  const fetchRequest = vi.fn();
  vi.stubGlobal("fetch", fetchRequest);

  await expect(collectUi()).rejects.toThrow("Set GOOGLE_API_KEY");
  expect(fetchRequest).not.toHaveBeenCalled();
});
