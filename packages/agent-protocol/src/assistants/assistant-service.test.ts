import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { resolveDeps } from "../deps.js";

import { createAssistantService } from "./assistant-service.js";

describe("assistant service", () => {
  it("registers one assistant per graph, id defaulting to graph_id, idempotently", async () => {
    const deps = resolveDeps(createFixtureDeps());
    const service = createAssistantService(deps);

    const first = await service.registerGraphAssistants();
    expect(first.map((a) => a.assistant_id).sort()).toEqual([
      "echo",
      "interrupting",
      "slow",
      "store",
      "throwing",
    ]);
    expect((await service.get("echo")).graph_id).toBe("echo");

    // Second registration doesn't duplicate.
    await service.registerGraphAssistants();
    expect((await service.list()).length).toBe(5);
  });

  it("returns schemas for a known assistant and 404s an unknown one", async () => {
    const deps = resolveDeps(createFixtureDeps());
    const service = createAssistantService(deps);
    await service.registerGraphAssistants();

    expect(await service.schemas("echo")).toEqual({ echo: { graph_id: "echo" } });
    await expect(service.schemas("ghost")).rejects.toMatchObject({ status: 404 });
    await expect(service.get("ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("searches by graph_id", async () => {
    const deps = resolveDeps(createFixtureDeps());
    const service = createAssistantService(deps);
    await service.registerGraphAssistants();

    const hits = await service.search({ graph_id: "echo" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.graph_id).toBe("echo");
  });
});
