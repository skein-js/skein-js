import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "./__fixtures__/deps.js";
import { createContext } from "./context.js";
import { buildProtocolService, createProtocolServiceFromContext } from "./service.js";

describe("createProtocolServiceFromContext", () => {
  it("assembles the full service surface over a shared context", () => {
    const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
    expect(Object.keys(service).sort()).toEqual([
      "assistants",
      "runs",
      "store",
      "threadStream",
      "threads",
    ]);
  });

  it("keeps the deprecated buildProtocolService alias pointing at the same function", () => {
    expect(buildProtocolService).toBe(createProtocolServiceFromContext);
  });
});
