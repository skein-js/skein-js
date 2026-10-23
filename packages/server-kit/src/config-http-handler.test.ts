import type { LanggraphJson } from "@skein-js/config";
import { Hono } from "hono";
import { expect, it } from "vitest";

import { loadConfigHttpHandler } from "./config-http-handler.js";

it("loads Fetch exports with their receiver and falls through on 404 without consuming the request", async () => {
  const app = {
    prefix: "custom",
    async fetch(request: Request) {
      if (new URL(request.url).pathname === "/info")
        return new Response(`${this.prefix}: ${await request.text()}`);
      await request.text();
      return new Response("missing", { status: 404 });
    },
  };
  const handler = await loadConfigHttpHandler(
    { graphs: {}, http: { app: "./app.ts:app" } } as LanggraphJson,
    {
      configDir: "/project",
      importModule: async (source) => {
        expect(source).toBe("/project/app.ts");
        return { app };
      },
    },
  );
  const response = await handler!(
    new Request("http://localhost/info", { method: "POST", body: "body" }),
  );
  expect(await response!.text()).toBe("custom: body");
  const original = new Request("http://localhost/threads", {
    method: "POST",
    body: '{ "key": 1 }',
  });
  expect(await handler!(original)).toBeUndefined();
  expect(await original.text()).toBe('{ "key": 1 }');
});
it("loads a real exported Hono application and falls through when it has no matching route", async () => {
  const app = new Hono().post("/custom", async (context) =>
    context.json({ body: await context.req.json() }),
  );
  const handler = await loadConfigHttpHandler(
    { graphs: {}, http: { app: "./custom.ts:app" } } as LanggraphJson,
    { configDir: process.cwd(), importModule: async () => ({ app }) },
  );
  const response = await handler!(
    new Request("http://localhost/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"value":"Hono"}',
    }),
  );
  expect(await response!.json()).toEqual({ body: { value: "Hono" } });
  expect(await handler!(new Request("http://localhost/unmatched"))).toBeUndefined();
});

it.each([200, 404])(
  "preserves streamed request bodies through a native %s response",
  async (status) => {
    const handler = await loadConfigHttpHandler(
      { graphs: {}, http: { app: "./app.ts:app" } } as LanggraphJson,
      {
        configDir: "/project",
        importModule: async () => ({
          app: (request: Request) => new Response(request.body, { status }),
        }),
      },
    );
    const request = new Request("http://localhost/threads", {
      method: "POST",
      body: "streamed body",
    });
    const response = await handler!(request);
    if (status === 404) {
      expect(response).toBeUndefined();
      expect(await request.text()).toBe("streamed body");
    } else {
      expect(await response!.text()).toBe("streamed body");
    }
  },
);
