// The precedence matrix is the whole contract here: an explicit `false` in `langgraph.json` must beat
// a present environment variable, and an unmentioned provider must defer to the environment. Getting
// that backwards would mean either silently shipping telemetry nobody asked for, or silently
// dropping the telemetry they did.

import { describe, expect, it, vi } from "vitest";

import type * as resolveTelemetryModule from "./resolve-telemetry.js";
import { resolveTelemetry, telemetryRuntimePackages } from "./resolve-telemetry.js";

const configDir = "/tmp/skein-telemetry-test";

describe("resolveTelemetry", () => {
  it("resolves nothing when neither config nor environment mentions telemetry", async () => {
    await expect(resolveTelemetry({ configDir, env: {} })).resolves.toEqual([]);
  });

  describe("environment auto-detection", () => {
    it("enables LangSmith only when tracing is explicitly on, not on a bare credential", async () => {
      // Turning tracing on ships every prompt and response to a third party. A `LANGSMITH_API_KEY`
      // lying around (plenty of tooling uses one) is not a request for that; `LANGSMITH_TRACING` is.
      await expect(
        resolveTelemetry({ configDir, env: { LANGSMITH_API_KEY: "lsv2_pt_x" } }),
      ).resolves.toEqual([]);

      const sinks = await resolveTelemetry({
        configDir,
        env: { LANGSMITH_API_KEY: "lsv2_pt_x", LANGSMITH_TRACING: "true" },
      });
      expect(sinks.map((sink) => sink.name)).toEqual(["langsmith"]);
    });

    it("accepts the legacy LANGCHAIN_ tracing variable too", async () => {
      const sinks = await resolveTelemetry({
        configDir,
        env: { LANGCHAIN_API_KEY: "lsv2_pt_x", LANGCHAIN_TRACING_V2: "true" },
      });
      expect(sinks.map((sink) => sink.name)).toEqual(["langsmith"]);
    });

    it("enables PostHog from an API key", async () => {
      const sinks = await resolveTelemetry({ configDir, env: { POSTHOG_API_KEY: "phc_x" } });
      expect(sinks.map((sink) => sink.name)).toEqual(["posthog"]);
    });

    it("enables OTel from the standard exporter variables", async () => {
      const sinks = await resolveTelemetry({
        configDir,
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
      });
      expect(sinks.map((sink) => sink.name)).toEqual(["otel"]);
    });

    it("enables several at once", async () => {
      const sinks = await resolveTelemetry({
        configDir,
        env: {
          LANGSMITH_API_KEY: "lsv2_pt_x",
          LANGSMITH_TRACING: "true",
          POSTHOG_API_KEY: "phc_x",
          OTEL_SERVICE_NAME: "api",
        },
      });
      expect(sinks.map((sink) => sink.name).sort()).toEqual(["langsmith", "otel", "posthog"]);
    });

    it("does not switch LangSmith's global tracer on for a merely-detected provider", async () => {
      // Detection means the operator already set `LANGSMITH_TRACING` themselves; we must not be the
      // ones flipping it, or the config block and the environment stop being distinguishable.
      const env: Record<string, string | undefined> = {
        LANGSMITH_API_KEY: "lsv2_pt_x",
        LANGSMITH_TRACING: "true",
      };
      await resolveTelemetry({ configDir, env });
      expect(env["LANGSMITH_TRACING"]).toBe("true");
    });
  });

  describe("a missing adapter package", () => {
    // The distinction that matters: a provider you *declared* must fail loudly if its package isn't
    // installed (a silent no-op for something you asked for is worse), while one merely *detected*
    // from the environment must degrade to off — platforms inject `OTEL_SERVICE_NAME` and the like
    // routinely, and refusing to boot over telemetry nobody configured is hostile.
    //
    // All three adapters are installed in this workspace, so the import is mocked to fail.
    async function withOtelUninstalled<T>(
      run: (module: typeof resolveTelemetryModule) => Promise<T>,
    ) {
      vi.resetModules();
      vi.doMock("@skein-js/otel", () => {
        throw new Error("Cannot find package '@skein-js/otel'");
      });
      try {
        return await run(await import("./resolve-telemetry.js"));
      } finally {
        vi.doUnmock("@skein-js/otel");
        vi.resetModules();
      }
    }

    it("degrades to off when the provider was only detected from the environment", async () => {
      const sinks = await withOtelUninstalled((module) =>
        module.resolveTelemetry({ configDir, env: { OTEL_SERVICE_NAME: "api" } }),
      );

      expect(sinks).toEqual([]);
    });

    it("fails loudly, naming the package, when the config declared it", async () => {
      await withOtelUninstalled(async (module) => {
        await expect(
          module.resolveTelemetry({ configDir, env: {}, config: { otel: true } }),
        ).rejects.toThrow(/install @skein-js\/otel/);
      });
    });
  });

  describe("the langgraph.json block", () => {
    it("enables a provider with `true` even when the environment says nothing", async () => {
      // OTel needs no credentials — whether anything records is the host SDK's business.
      const sinks = await resolveTelemetry({ configDir, env: {}, config: { otel: true } });
      expect(sinks.map((sink) => sink.name)).toEqual(["otel"]);
    });

    it("hard-disables a provider with `false`, beating a present environment variable", async () => {
      const sinks = await resolveTelemetry({
        configDir,
        env: { POSTHOG_API_KEY: "phc_x" },
        config: { posthog: false },
      });
      expect(sinks).toEqual([]);
    });

    it("passes an options object through to the adapter", async () => {
      // A project name is enough to configure LangSmith, with no API key anywhere.
      const sinks = await resolveTelemetry({
        configDir,
        env: {},
        config: { langsmith: { projectName: "my-agents", enableTracing: false } },
      });
      expect(sinks.map((sink) => sink.name)).toEqual(["langsmith"]);
    });

    it("leaves an unmentioned provider to the environment", async () => {
      const sinks = await resolveTelemetry({
        configDir,
        env: { POSTHOG_API_KEY: "phc_x" },
        config: { langsmith: false },
      });
      expect(sinks.map((sink) => sink.name)).toEqual(["posthog"]);
    });

    it("treats an enabled-but-unconfigured provider as off rather than half-built", async () => {
      // `langsmith: true` with no key anywhere: the adapter returns undefined, and we drop it.
      const sinks = await resolveTelemetry({ configDir, env: {}, config: { langsmith: true } });
      expect(sinks).toEqual([]);
    });
  });

  describe("custom sinks", () => {
    it("loads a sink exported from a path", async () => {
      const sinks = await resolveTelemetry({
        configDir,
        env: {},
        config: { paths: ["./my-telemetry.ts:sink"] },
        importModule: async () => ({ sink: { name: "custom" } }),
      });
      expect(sinks.map((s) => s.name)).toEqual(["custom"]);
    });

    it("calls a factory export, so a module can read its own configuration", async () => {
      const sinks = await resolveTelemetry({
        configDir,
        env: {},
        config: { paths: ["./my-telemetry.ts:createSink"] },
        importModule: async () => ({ createSink: () => ({ name: "from-factory" }) }),
      });
      expect(sinks.map((s) => s.name)).toEqual(["from-factory"]);
    });

    it("names the missing export rather than failing opaquely", async () => {
      await expect(
        resolveTelemetry({
          configDir,
          env: {},
          config: { paths: ["./my-telemetry.ts:sink"] },
          importModule: async () => ({ somethingElse: {} }),
        }),
      ).rejects.toThrow(/has no export "sink"/);
    });

    it("rejects an export that is not a sink", async () => {
      await expect(
        resolveTelemetry({
          configDir,
          env: {},
          config: { paths: ["./my-telemetry.ts:sink"] },
          importModule: async () => ({ sink: "not a sink" }),
        }),
      ).rejects.toThrow(/must resolve to a TelemetrySink/);
    });

    it("combines custom sinks with provider ones", async () => {
      const sinks = await resolveTelemetry({
        configDir,
        env: { POSTHOG_API_KEY: "phc_x" },
        config: { paths: ["./my-telemetry.ts:sink"] },
        importModule: async () => ({ sink: { name: "custom" } }),
      });
      expect(sinks.map((s) => s.name)).toEqual(["posthog", "custom"]);
    });
  });
});

describe("telemetryRuntimePackages", () => {
  it("is empty when no telemetry is configured", () => {
    expect(telemetryRuntimePackages(undefined)).toEqual([]);
    expect(telemetryRuntimePackages({})).toEqual([]);
  });

  it("names the packages a declared provider needs installed in the image", () => {
    expect(
      telemetryRuntimePackages({ langsmith: true, posthog: { host: "https://eu.i.posthog.com" } }),
    ).toEqual(["@skein-js/langsmith", "@skein-js/posthog"]);
  });

  it("skips a provider that is explicitly disabled", () => {
    expect(telemetryRuntimePackages({ langsmith: false, otel: true })).toEqual(["@skein-js/otel"]);
  });
});
