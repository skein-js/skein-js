import { afterEach, expect, it, vi } from "vitest";

import { generateModelText } from "./generation.js";

const noLookup = () =>
  Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: "Ask for a repo" }] } }],
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("cancels an active Google request without an unhandled rejection", async () => {
  vi.stubEnv("A2UI_MODEL", "google-genai:gemini-test");
  vi.stubEnv("GOOGLE_API_KEY", "test-key");
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      if (request.url.includes(":generateContent")) return noLookup();
      signal = request.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"partial"}]}}]}\n\n',
              ),
            );
            request.signal.addEventListener(
              "abort",
              () => controller.error(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const controller = new AbortController();

  const stream = generateModelText(
    {
      prompt: "A dashboard",
      generationId: crypto.randomUUID(),
      systemPrompt: "Return a UI",
      previousUi: null,
    },
    controller.signal,
  )[Symbol.asyncIterator]();
  expect((await stream.next()).value).toBe("partial");
  const pending = stream.next();
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  await stream.return?.();
  expect(signal?.aborted).toBe(true);
});

it("reports a dropped Google stream and accepts another generation without an unhandled rejection", async () => {
  vi.stubEnv("A2UI_MODEL", "google-genai:gemini-test");
  vi.stubEnv("GOOGLE_API_KEY", "test-key");
  const event = new TextEncoder().encode(
    'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"recovered"}]}}]}\n\n',
  );

  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) =>
      request.url.includes(":generateContent")
        ? noLookup()
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(event);
                if (fail) controller.error(new Error("stream disconnected"));
                else controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
    ),
  );

  const collect = async () => {
    let text = "";
    for await (const chunk of generateModelText({
      prompt: "A dashboard",
      generationId: crypto.randomUUID(),
      systemPrompt: "Return a UI",
      previousUi: null,
    }))
      text += chunk;
    return text;
  };

  await expect(collect()).rejects.toThrow("stream disconnected");
  fail = false;
  await expect(collect()).resolves.toBe("recovered");
});
