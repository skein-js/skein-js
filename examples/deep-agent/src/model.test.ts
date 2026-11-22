import { afterEach, expect, it, vi } from "vitest";

import { selectModel } from "./model.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([undefined, "   "])("requires Gemini credentials for the default model (%j)", (key) => {
  vi.stubEnv("GOOGLE_API_KEY", key);
  vi.stubEnv("DEEP_AGENT_MODEL", undefined);
  expect(() => selectModel("assistant")).toThrow("Set GOOGLE_API_KEY");
});

it("uses the configured Gemini model", () => {
  vi.stubEnv("GOOGLE_API_KEY", "test-key");
  vi.stubEnv("DEEP_AGENT_MODEL", "google-genai:gemini-3.5-flash-lite");
  expect(selectModel("researcher")).toBe("google-genai:gemini-3.5-flash-lite");
});
