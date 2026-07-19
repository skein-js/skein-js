// Regression: the protocol must follow `app.setGlobalPrefix()`. Nest bakes the global prefix into the
// middleware's mount path but leaves it on the request, so before the strip in `SkeinMiddleware` every
// protocol path 404'd under a prefixed app — the middleware either never ran (`/threads`) or ran and
// failed to match the anchored route table (`/api/threads`). These boot a real prefixed Nest app.

// NestJS's DI reads decorator metadata via reflect-metadata; load it before any Nest code runs.
import "reflect-metadata";

import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { INestApplication } from "@nestjs/common";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { resolveProtocolRuntime } from "@skein-js/server-kit";
import { afterEach, describe, expect, it } from "vitest";

import { createEchoDeps } from "./__fixtures__/echo-server.js";
import { SkeinInvokeModule } from "./skein-invoke.module.js";
import { SkeinMiddleware } from "./skein.middleware.js";
import { SkeinModule } from "./skein.module.js";

const jsonHeaders = { "content-type": "application/json" };

// Deliberately NOT `@Controller("api/todos")`: the prefix supplies the `/api`, which is the whole
// point — the host app writes its routes prefix-relative and skein has to keep up.
@Controller("todos")
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

/** Boot a host app that mounts skein alongside its own controller, under a global prefix. */
async function startPrefixedServer(prefix: string): Promise<Running> {
  @Module({
    imports: [SkeinModule.forRoot({ deps: createEchoDeps() })],
    controllers: [TodosController],
  })
  class AppModule {}

  const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
  // After `create()`, before `listen()` — the ordering every real app uses, and the reason the
  // middleware reads the prefix per request rather than snapshotting it in its constructor.
  app.setGlobalPrefix(prefix);
  app.enableShutdownHooks();
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

/** Boot the simplified invoke surface under a global prefix. */
async function startPrefixedInvokeServer(prefix: string): Promise<Running> {
  @Module({ imports: [SkeinInvokeModule.forRoot({ deps: createEchoDeps() })] })
  class AppModule {}

  const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix(prefix);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

const createThread = (baseUrl: string) =>
  fetch(`${baseUrl}/threads`, { method: "POST", headers: jsonHeaders, body: "{}" });

describe("SkeinModule under app.setGlobalPrefix()", () => {
  let running: Running | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("serves the protocol under the prefix", async () => {
    running = await startPrefixedServer("api");

    const created = await createThread(`${running.baseUrl}/api`);
    expect(created.status).toBe(200);
    const { thread_id: threadId } = (await created.json()) as { thread_id: string };
    expect(threadId).toBeTruthy();

    const fetched = await fetch(`${running.baseUrl}/api/threads/${threadId}`);
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { thread_id: string }).thread_id).toBe(threadId);
  });

  it("leaves the host app's own controllers alone under the prefix", async () => {
    running = await startPrefixedServer("api");

    const response = await fetch(`${running.baseUrl}/api/todos`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 1 }]);
  });

  it("passes a non-skein path under the prefix through to Nest", async () => {
    running = await startPrefixedServer("api");

    // 404 from Nest's router, not a middleware claim — proves the pass-through contract still holds.
    expect((await fetch(`${running.baseUrl}/api/not-a-route`)).status).toBe(404);
  });

  it("does not claim protocol paths outside the prefix", async () => {
    running = await startPrefixedServer("api");

    expect((await createThread(running.baseUrl)).status).toBe(404);
  });

  it("normalizes a prefix written with slashes", async () => {
    // `setGlobalPrefix` stores the raw string, so the strip has to normalize it.
    running = await startPrefixedServer("/api/");

    expect((await createThread(`${running.baseUrl}/api`)).status).toBe(200);
  });

  it("streams SSE under the prefix", async () => {
    running = await startPrefixedServer("api");

    const response = await fetch(`${running.baseUrl}/api/runs/stream`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        assistant_id: "echo",
        input: { messages: [{ role: "user", content: "hi" }] },
      }),
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("echo: hi");
    expect(text).toContain("event: end");
  });

  it("serves the protocol under a multi-segment prefix", async () => {
    running = await startPrefixedServer("/api/v1");

    expect((await createThread(`${running.baseUrl}/api/v1`)).status).toBe(200);
  });
});

describe("SkeinMiddleware constructed by hand", () => {
  it("still works without an ApplicationConfig (it is a public export)", async () => {
    // `SkeinMiddleware` is exported "for callers wiring their own module", so the 3-argument
    // construction must keep working — an unguarded `appConfig.getGlobalPrefix()` would TypeError
    // here and 500 every request. No config simply means no global prefix.
    const resolved = await resolveProtocolRuntime({ deps: createEchoDeps() });
    try {
      const middleware = new SkeinMiddleware(resolved, null, null);
      let passedThrough = false;

      await middleware.use(
        { url: "/not-a-skein-route", method: "GET", headers: { host: "localhost" } } as never,
        {} as ServerResponse,
        () => {
          passedThrough = true;
        },
      );

      expect(passedThrough).toBe(true);
    } finally {
      await resolved.runtime.worker.stop();
    }
  });
});

describe("SkeinInvokeModule under app.setGlobalPrefix()", () => {
  let running: Running | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("serves the invoke surface under the prefix", async () => {
    running = await startPrefixedInvokeServer("api");

    const response = await fetch(`${running.baseUrl}/api/invoke/echo`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(200);
    const state = (await response.json()) as { messages: Array<{ content: string }> };
    expect(state.messages.at(-1)?.content).toBe("echo: hi");
  });
});
