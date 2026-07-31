import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { resolveDeps } from "../deps.js";

import { createMetaService } from "./server-info.js";

const infoWith = (
  deps: Parameters<typeof createFixtureDeps>[0] = {},
  env: Record<string, string | undefined> = {},
) => createMetaService(resolveDeps(createFixtureDeps(deps)), env).info();

describe("GET /info", () => {
  it("reports the JS context, the served resources, and crons as not yet built", async () => {
    const info = await infoWith();

    expect(info.context).toBe("js");
    expect(info.flags.assistants).toBe(true);
    // Honest rather than flattering: scheduled runs are still on the roadmap, and a client that
    // feature-detects this must not be told otherwise.
    expect(info.flags.crons).toBe(false);
  });

  it("reports the loaded @langchain/langgraph version", async () => {
    // Read through the dependency's own `./package.json` export, so a bundled build still resolves it.
    const info = await infoWith();
    expect(info.langgraph_js_version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reports skein's version only when the host injected one", async () => {
    // A library must not read its own package.json at runtime, so an un-told server omits the field
    // rather than reporting a stale compiled-in constant.
    expect(await infoWith()).not.toHaveProperty("version");
    expect((await infoWith({ serverVersion: "1.2.3" })).version).toBe("1.2.3");
  });

  it("mirrors LangGraph's langsmith detection: a key enables it, an explicit false wins", async () => {
    expect((await infoWith({}, {})).flags.langsmith).toBe(false);
    expect((await infoWith({}, { LANGSMITH_API_KEY: "sk-test" })).flags.langsmith).toBe(true);
    expect((await infoWith({}, { LANGCHAIN_API_KEY: "sk-test" })).flags.langsmith).toBe(true);
    expect(
      (await infoWith({}, { LANGSMITH_API_KEY: "sk-test", LANGSMITH_TRACING: "false" })).flags
        .langsmith,
    ).toBe(false);
    // Python's `False` spelling too, which is what a shared .env across both SDKs carries.
    expect(
      (await infoWith({}, { LANGSMITH_API_KEY: "sk-test", LANGCHAIN_TRACING_V2: "False" })).flags
        .langsmith,
    ).toBe(false);
  });
});
