import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { resolveDeps } from "../deps.js";

import { createStoreService } from "./store-service.js";

describe("store service", () => {
  it("puts, gets, searches, lists namespaces, and deletes", async () => {
    const service = createStoreService(resolveDeps(createFixtureDeps()));

    await service.put(["users", "1"], "profile", { name: "Ada" });
    expect((await service.get(["users", "1"], "profile")).value).toEqual({ name: "Ada" });

    const hits = await service.search({ prefix: ["users"] });
    expect(hits).toHaveLength(1);

    expect(await service.listNamespaces({ prefix: ["users"] })).toEqual([["users", "1"]]);

    await service.delete(["users", "1"], "profile");
    await expect(service.get(["users", "1"], "profile")).rejects.toMatchObject({ status: 404 });
  });
});
