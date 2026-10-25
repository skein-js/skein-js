import { SkeinHttpError, type AuthEngine } from "@skein-js/core";
import { expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import type { ProtocolRequest } from "../create-handlers.js";
import { skeinRoutes } from "../http/routes.js";
import { createProtocolRuntime } from "../runtime.js";

it("authenticates before a custom Fetch application and leaves the body available", async () => {
  const httpHandler = vi.fn(async (request: Request) => new Response(await request.text()));
  const auth = {
    studioAuthDisabled: true,
    authenticate: async (request: Request) => {
      if (request.headers.get("authorization") !== "Bearer allowed")
        throw SkeinHttpError.unauthorized("Missing token");
      expect(await request.text()).toBe("payload");
      return undefined;
    },
  } as unknown as AuthEngine;
  const runtime = createProtocolRuntime(createFixtureDeps({ auth, httpHandler }));
  await expect(
    runtime.handleRequest!(
      new Request("http://localhost/custom", { method: "POST", body: "payload" }),
    ),
  ).rejects.toMatchObject({ status: 401 });
  expect(httpHandler).not.toHaveBeenCalled();
  const response = await runtime.handleRequest!(
    new Request("http://localhost/custom", {
      method: "POST",
      headers: { authorization: "Bearer allowed" },
      body: "payload",
    }),
  );
  expect(await response!.text()).toBe("payload");
});

it("preserves mounted public handshakes and provider-authenticated callbacks with native fallthrough", async () => {
  const authenticate = vi.fn(async () => {
    throw SkeinHttpError.unauthorized("Missing deployment token");
  });
  const auth: AuthEngine = {
    enabled: true,
    studioAuthDisabled: true,
    authenticate,
    authorize: async ({ value }) => ({ value }),
    matchesFilters: () => true,
  };
  const httpHandler = vi.fn(async () => undefined);
  const runtime = createProtocolRuntime(createFixtureDeps({ auth, httpHandler }), {
    routes: [
      ...skeinRoutes,
      {
        method: "post",
        path: "/callbacks/:route_name",
        handler: "handleInboundEvent",
        retainRawBody: true,
      },
    ],
    handlers: {
      handleInboundEvent: async (request) => {
        if (request.headers["x-provider-signature"] !== "valid")
          throw SkeinHttpError.unauthorized("Invalid provider signature");
        return { kind: "json", status: 200, body: { received: request.body } };
      },
    },
  });
  expect(await runtime.handleRequest!(new Request("http://localhost/info"))).toBeUndefined();
  expect((await runtime.handlers.getServerInfo(protocolRequest("GET", "/info"))).status).toBe(200);
  const callback = new Request("http://localhost/callbacks/support", {
    method: "POST",
    headers: { "x-provider-signature": "valid" },
    body: "signed body",
  });
  expect(await runtime.handleRequest!(callback)).toBeUndefined();
  const received = await runtime.handlers.handleInboundEvent!({
    ...protocolRequest("POST", "/callbacks/support"),
    params: { route_name: "support" },
    headers: { "x-provider-signature": "valid" },
    body: await callback.text(),
  });
  expect(received).toMatchObject({ status: 200, body: { received: "signed body" } });
  await expect(
    runtime.handlers.handleInboundEvent!(protocolRequest("POST", "/callbacks/support")),
  ).rejects.toMatchObject({ status: 401 });
  expect(authenticate).not.toHaveBeenCalled();
  expect(httpHandler).toHaveBeenCalledTimes(2);
  for (const [method, path] of [
    ["GET", "/docs"],
    ["GET", "/metrics"],
    ["GET", "/info/private"],
    ["POST", "/info"],
    ["POST", "/threads"],
  ]) {
    await expect(
      runtime.handleRequest!(new Request(`http://localhost${path}`, { method })),
    ).rejects.toMatchObject({ status: 401 });
  }
});

it("does not exempt custom routes when their public protocol group is disabled", async () => {
  const auth = {
    studioAuthDisabled: true,
    authenticate: async () => {
      throw SkeinHttpError.unauthorized("Missing token");
    },
  } as unknown as AuthEngine;
  const httpHandler = vi.fn(async () => new Response("custom"));
  const runtime = createProtocolRuntime(createFixtureDeps({ auth, httpHandler }), {
    routes: skeinRoutes.filter((route) => route.group !== "meta"),
  });
  await expect(runtime.handleRequest!(new Request("http://localhost/info"))).rejects.toMatchObject({
    status: 401,
  });
  expect(httpHandler).not.toHaveBeenCalled();
});

function protocolRequest(method: string, path: string): ProtocolRequest {
  return {
    method,
    url: `http://localhost${path}`,
    params: {},
    headers: {},
    query: {},
    body: undefined,
  };
}
