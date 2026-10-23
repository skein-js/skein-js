import { expect, it } from "vitest";

import { createEchoDeps, startEchoServer } from "./__fixtures__/echo-server.js";

it.each(["server"] as const)(
  "%s serves native responses before protocol routes and preserves fallthrough JSON",
  async (router) => {
    void router;
    const deps = createEchoDeps();
    deps.httpHandler = async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/info")
        return new Response("custom info", {
          status: 201,
          headers: { "content-type": "text/plain" },
        });
      if (path === "/custom")
        return new Response(JSON.stringify(await request.json()), {
          headers: { "content-type": "application/json" },
        });
      if (path === "/asset")
        return new Response(new Uint8Array([0, 255, 42]), {
          headers: { "content-type": "application/octet-stream" },
        });
      return undefined;
    };
    const running = await startEchoServer({ deps });
    try {
      const info = await fetch(`${running.baseUrl}/info`);
      expect(info.status).toBe(201);
      expect(await info.text()).toBe("custom info");
      const custom = await fetch(`${running.baseUrl}/custom`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{ "message": "native" }',
      });
      expect(custom.status).toBe(200);
      expect(await custom.json()).toEqual({ message: "native" });
      const asset = await fetch(`${running.baseUrl}/asset`);
      expect([...new Uint8Array(await asset.arrayBuffer())]).toEqual([0, 255, 42]);
      const thread = await fetch(`${running.baseUrl}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{ "metadata": { "from": "fallback" } }',
      });
      expect(thread.status).toBe(200);
      expect(await thread.json()).toMatchObject({ metadata: { from: "fallback" } });
    } finally {
      await running.close();
    }
  },
);

it("leaves unrelated raw host request streams readable when only diagnostics use native routing", async () => {
  const running = await startEchoServer();
  running.server.app.post("/host", async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.type("application/octet-stream").send(Buffer.concat(chunks));
  });
  try {
    const response = await fetch(`${running.baseUrl}/host`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([0, 255, 42]),
    });
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 42]);
  } finally {
    await running.close();
  }
});
