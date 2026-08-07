// Response-shape parity against the installed `@langchain/langgraph-sdk`.
//
// `sdk-body-parity.test.ts` guards the *request* side — every field the SDK sends is named by a skein
// schema. Nothing guarded the *response* side, and three defects lived there: `searchItems()` threw
// `TypeError: Cannot read properties of undefined (reading 'map')` because skein returned a bare array
// where the client dereferences `.items`; `listNamespaces()` failed silently with `.namespaces`
// undefined; and every item came back with `createdAt`/`updatedAt` undefined, because the client maps
// `created_at → createdAt` and skein emitted camelCase.
//
// So: drive the *real* `Client`, not a hand-written assertion about what the wire looks like. The
// SDK's `overrideFetchImplementation` points it straight at the handler table, so this needs no HTTP
// server and no adapter — the thing under test is the response body, and a socket would only add
// moving parts between the handler and the client.

import { Client, overrideFetchImplementation } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolHandlers, type ProtocolHandlers } from "../create-handlers.js";
import { createProtocolServiceFromContext } from "../service.js";

/** The store slice of the route table, enough to dispatch what `client.store` calls. */
const STORE_ROUTES: [string, string, keyof ProtocolHandlers][] = [
  ["PUT", "/store/items", "putStoreItem"],
  ["GET", "/store/items", "getStoreItem"],
  ["DELETE", "/store/items", "deleteStoreItem"],
  ["POST", "/store/items/search", "searchStoreItems"],
  ["POST", "/store/namespaces", "listStoreNamespaces"],
];

let client: Client;

beforeAll(async () => {
  const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
  await service.assistants.registerGraphAssistants();
  const handlers = createProtocolHandlers(service);

  overrideFetchImplementation(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = STORE_ROUTES.find(
      ([method, path]) => method === (init?.method ?? "GET") && path === url.pathname,
    );
    if (!route) return new Response("not found", { status: 404 });

    const response = await handlers[route[2]]({
      method: route[0].toLowerCase(),
      url: url.toString(),
      params: {},
      query: Object.fromEntries(url.searchParams),
      body: init?.body === undefined ? {} : JSON.parse(String(init.body)),
      headers: {},
    });

    if (response.kind === "empty") return new Response(null, { status: response.status });
    return new Response(JSON.stringify((response as { body: unknown }).body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });

  client = new Client({ apiUrl: "http://handlers.test" });

  await client.store.putItem(["users", "1", "facts"], "a", { topic: "coffee", score: 5 });
  await client.store.putItem(["users", "2", "facts"], "b", { topic: "tea", score: 2 });
});

afterAll(() => {
  // The override is a module-level singleton; leaving it set would leak into any other suite that
  // constructs a Client in the same worker.
  overrideFetchImplementation(fetch);
});

describe("store responses, read by the real SDK client", () => {
  it("gives searchItems an { items } envelope it can read", async () => {
    const found = await client.store.searchItems(["users"]);

    expect(found.items.map((item) => item.key).sort()).toEqual(["a", "b"]);
  });

  it("gives listNamespaces a { namespaces } envelope it can read", async () => {
    const found = await client.store.listNamespaces({ prefix: ["users", "*"] });

    expect(found.namespaces).toEqual([
      ["users", "1", "facts"],
      ["users", "2", "facts"],
    ]);
  });

  it("carries timestamps through the client's created_at → createdAt mapping", async () => {
    const item = await client.store.getItem(["users", "1", "facts"], "a");

    expect(item?.createdAt).toEqual(expect.any(String));
    expect(item?.updatedAt).toEqual(expect.any(String));
  });

  it("narrows a search by the filter the client sends", async () => {
    const found = await client.store.searchItems(["users"], { filter: { score: { $gt: 3 } } });

    expect(found.items.map((item) => item.key)).toEqual(["a"]);
  });
});
