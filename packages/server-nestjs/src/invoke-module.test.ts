// The simplified serving surface over real HTTP on NestJS: raw body in / final state out, opt-in SSE,
// an unregistered graph 404s, and the middleware claims only the invoke path so the host app's own
// controllers still serve.

import type { AddressInfo } from "node:net";

import { Controller, Get, Module } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";

import { createEchoDeps } from "./__fixtures__/echo-server.js";
import { SkeinInvokeModule } from "./skein-invoke.module.js";

const jsonHeaders = { "content-type": "application/json" };

@Controller("api/todos")
class TodosController {
  @Get()
  list(): Array<{ id: number }> {
    return [{ id: 1 }];
  }
}

interface Running {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Boot a Nest app importing `SkeinInvokeModule` alongside the app's own controller. */
async function startInvokeServer(): Promise<Running> {
  @Module({
    imports: [SkeinInvokeModule.forRoot({ deps: createEchoDeps() })],
    controllers: [TodosController],
  })
  class AppModule {}

  const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

const invoke = (
  baseUrl: string,
  graphId: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${baseUrl}/invoke/${graphId}`, {
    method: "POST",
    headers: { ...jsonHeaders, ...headers },
    body: JSON.stringify(body),
  });

describe("SkeinInvokeModule", () => {
  let running: Running | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("returns the graph's final state for the posted input", async () => {
    running = await startInvokeServer();

    const response = await invoke(running.baseUrl, "echo", {
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(200);
    const state = (await response.json()) as { messages: Array<{ content: string }> };
    expect(state.messages.at(-1)?.content).toBe("echo: hi");
  });

  it("404s an unregistered graph id", async () => {
    running = await startInvokeServer();

    expect((await invoke(running.baseUrl, "nope", { messages: [] })).status).toBe(404);
  });

  it("streams SSE when the caller asks for it", async () => {
    running = await startInvokeServer();

    const response = await invoke(
      running.baseUrl,
      "echo",
      { messages: [{ role: "user", content: "hi" }] },
      { accept: "text/event-stream" },
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("echo: hi");
    expect(text).toContain(`"status":"success"`);
  });

  it("leaves the host app's own controllers alone", async () => {
    running = await startInvokeServer();

    const response = await fetch(`${running.baseUrl}/api/todos`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 1 }]);
  });
});
