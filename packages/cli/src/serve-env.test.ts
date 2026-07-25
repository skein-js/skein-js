import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONTAINER_PORT,
  DEFAULT_DEV_PORT,
  describeBindError,
  envHost,
  envPort,
} from "./serve-env.js";

const original = { PORT: process.env.PORT, HOST: process.env.HOST };

/** Set (or clear) a var for one test; `afterEach` puts the real environment back. */
function setEnv(name: "PORT" | "HOST", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("PORT", original.PORT);
  setEnv("HOST", original.HOST);
});

describe("envPort", () => {
  it("falls back when PORT is unset or blank", () => {
    setEnv("PORT", undefined);
    expect(envPort(DEFAULT_CONTAINER_PORT)).toBe(DEFAULT_CONTAINER_PORT);
    setEnv("PORT", "   ");
    expect(envPort(DEFAULT_CONTAINER_PORT)).toBe(DEFAULT_CONTAINER_PORT);
  });

  it("honors a valid PORT, so platform-injected ports win over the default", () => {
    setEnv("PORT", "8080");
    expect(envPort(DEFAULT_CONTAINER_PORT)).toBe(8080);
  });

  it("falls back rather than throwing on a nonsense PORT", () => {
    // A hosting platform's env is not a place to hard-fail: an unusable value means "bind the
    // default", which at least yields a reachable server rather than a container that won't boot.
    for (const raw of ["not-a-port", "8080.5", "-1", "70000"]) {
      setEnv("PORT", raw);
      expect(envPort(DEFAULT_CONTAINER_PORT)).toBe(DEFAULT_CONTAINER_PORT);
    }
  });
});

describe("envHost", () => {
  it("falls back when HOST is unset or blank, and honors a set one", () => {
    setEnv("HOST", undefined);
    expect(envHost("127.0.0.1")).toBe("127.0.0.1");
    setEnv("HOST", "  ");
    expect(envHost("127.0.0.1")).toBe("127.0.0.1");
    setEnv("HOST", "0.0.0.0");
    expect(envHost("127.0.0.1")).toBe("0.0.0.0");
  });
});

describe("port defaults", () => {
  it("keeps `dev` on the LangGraph-compatible port and containers on the exposed one", () => {
    // These differ on purpose (`langgraph dev` is 2024, `langgraph up` is 8123). The container port
    // is the one the generated Dockerfile EXPOSEs and health-checks — see templates.test.ts.
    expect(DEFAULT_DEV_PORT).toBe(2024);
    expect(DEFAULT_CONTAINER_PORT).toBe(8123);
  });
});

describe("describeBindError", () => {
  it("turns EADDRINUSE into an actionable hint and passes anything else through", () => {
    const inUse = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    expect(describeBindError(inUse, 8123)).toContain("port 8123 is already in use");
    expect(describeBindError(new Error("boom"), 8123)).toContain("boom");
  });
});
