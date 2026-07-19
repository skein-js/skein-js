// The simplified serving surface on the Next.js App Router. The handler is a plain
// `(Request) => Promise<Response>`, so these drive it directly — no bridge server needed: raw body in
// / final state out, opt-in SSE, an unregistered graph 404s, and a path outside the mount is not ours.

import { describe, expect, it } from "vitest";

import { createEchoDeps } from "./__fixtures__/echo-server.js";
import { createSkeinInvokeRouteHandlers } from "./create-invoke-route-handlers.js";

const BASE = "/api/invoke";

/** Fresh handlers per test — `getSkeinInvokeDeps` memoizes by deps identity, so these stay isolated. */
function handlers() {
  return createSkeinInvokeRouteHandlers({ deps: createEchoDeps(), basePath: BASE });
}

function invokeRequest(graphId: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${BASE}/${graphId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("createSkeinInvokeRouteHandlers", () => {
  it("returns the graph's final state for the posted input", async () => {
    const response = await handlers().POST(
      invokeRequest("echo", { messages: [{ role: "user", content: "hi" }] }),
    );

    expect(response.status).toBe(200);
    const state = (await response.json()) as { messages: Array<{ content: string }> };
    expect(state.messages.at(-1)?.content).toBe("echo: hi");
  });

  it("404s an unregistered graph id", async () => {
    const response = await handlers().POST(invokeRequest("nope", { messages: [] }));

    expect(response.status).toBe(404);
  });

  it("streams SSE when the caller asks for it", async () => {
    const response = await handlers().POST(
      invokeRequest(
        "echo",
        { messages: [{ role: "user", content: "hi" }] },
        { accept: "text/event-stream" },
      ),
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("echo: hi");
    expect(text).toContain(`"status":"success"`);
  });

  // `decodeURIComponent` throws on a malformed escape; unguarded it escaped the handler's try/catch.
  it("404s a malformed percent-escape instead of throwing a URIError", async () => {
    const response = await handlers().POST(
      new Request("http://localhost/api/invoke/%zz", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(404);
  });

  it("404s a path outside the mount, and a nested path that isn't a bare graph id", async () => {
    const outside = await handlers().POST(
      new Request("http://localhost/somewhere/else", { method: "POST", body: "{}" }),
    );
    const nested = await handlers().POST(
      new Request(`http://localhost${BASE}/echo/extra`, { method: "POST", body: "{}" }),
    );

    expect(outside.status).toBe(404);
    expect(nested.status).toBe(404);
  });
});
