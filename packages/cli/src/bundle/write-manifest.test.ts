import type { LanggraphJson } from "@skein-js/config";
import { describe, expect, it } from "vitest";

import { buildArtifactPackageJson, buildProductionConfig } from "./write-manifest.js";

describe("buildProductionConfig", () => {
  const base: LanggraphJson = {
    graphs: { agent: "./src/agent.ts:graph", echo: "./src/echo.ts" },
    node_version: "20",
  };

  it("rewrites graph specs to point at the bundled JS", () => {
    const config = buildProductionConfig(base, {
      graphs: { agent: "./graphs/agent.js:graph", echo: "./graphs/echo.js:default" },
    });
    expect(config.graphs).toEqual({
      agent: "./graphs/agent.js:graph",
      echo: "./graphs/echo.js:default",
    });
    // Untouched fields pass through.
    expect(config.node_version).toBe("20");
  });

  it("rewrites auth.path only when auth was declared, preserving its other keys", () => {
    const withAuth: LanggraphJson = {
      ...base,
      auth: { path: "./src/auth.ts:auth", disable_studio_auth: true },
    };
    const config = buildProductionConfig(withAuth, {
      graphs: { agent: "./graphs/agent.js:graph", echo: "./graphs/echo.js:default" },
      auth: "./auth.js:auth",
    });
    expect(config.auth).toEqual({ path: "./auth.js:auth", disable_studio_auth: true });
  });

  it("rewrites a custom-function embed while keeping dims/fields", () => {
    const withEmbed: LanggraphJson = {
      ...base,
      store: { index: { embed: "./src/embed.ts:embed", dims: 1536, fields: ["text"] } },
    };
    const config = buildProductionConfig(withEmbed, {
      graphs: base.graphs,
      embed: "./embed.js:embed",
    });
    expect(config.store?.index).toEqual({
      embed: "./embed.js:embed",
      dims: 1536,
      fields: ["text"],
    });
  });

  it("rewrites store.adapter, so a built image does not name a .ts file it does not contain", () => {
    // Left unrewritten, the production config still points at `./src/my-store.ts` and the server fails at
    // boot with "failed to import module" — on the module the entire `/store/*` surface runs on.
    const withAdapter: LanggraphJson = {
      ...base,
      store: { adapter: "./src/my-store.ts:store", ttl: { default_ttl: 60 } },
    };

    const config = buildProductionConfig(withAdapter, {
      graphs: base.graphs,
      storeAdapter: "./store-adapter.js:store",
    });

    expect(config.store).toEqual({
      adapter: "./store-adapter.js:store",
      ttl: { default_ttl: 60 },
    });
  });

  it("drops a string (file-path) env but keeps an inline env map", () => {
    const fileEnv = buildProductionConfig({ ...base, env: ".env" }, { graphs: base.graphs });
    expect(fileEnv.env).toBeUndefined();

    const inlineEnv = buildProductionConfig(
      { ...base, env: { LOG_LEVEL: "info" } },
      { graphs: base.graphs },
    );
    expect(inlineEnv.env).toEqual({ LOG_LEVEL: "info" });
  });

  it("does not mutate the source config", () => {
    const source: LanggraphJson = { ...base, env: ".env" };
    buildProductionConfig(source, { graphs: { agent: "./graphs/agent.js:graph" } });
    expect(source.graphs).toEqual({ agent: "./src/agent.ts:graph", echo: "./src/echo.ts" });
    expect(source.env).toBe(".env");
  });
});

describe("buildArtifactPackageJson", () => {
  it("emits a private ESM package with sorted, exact-pinned dependencies", () => {
    const json = buildArtifactPackageJson("my-app", {
      "@langchain/langgraph": "1.4.0",
      "skein-js": "0.3.0",
      "@langchain/openai": "0.3.1",
    });
    const parsed = JSON.parse(json) as {
      name: string;
      private: boolean;
      type: string;
      dependencies: Record<string, string>;
    };
    expect(parsed.name).toBe("my-app-skein-artifact");
    expect(parsed.private).toBe(true);
    expect(parsed.type).toBe("module");
    expect(Object.keys(parsed.dependencies)).toEqual([
      "@langchain/langgraph",
      "@langchain/openai",
      "skein-js",
    ]);
    expect(parsed.dependencies["skein-js"]).toBe("0.3.0");
    expect(json.endsWith("\n")).toBe(true);
  });
});
