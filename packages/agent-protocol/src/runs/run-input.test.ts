import { isCommand } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import {
  normalizeModes,
  toFactoryConfigurable,
  toGraphCallOptions,
  toGraphInput,
  toGraphStreamModes,
  wantsEventsMode,
} from "./run-input.js";

describe("normalizeModes", () => {
  it("defaults to values when nothing is requested", () => {
    expect(normalizeModes()).toEqual(["values"]);
    expect(normalizeModes([])).toEqual(["values"]);
  });

  it("maps SDK aliases onto graph modes and de-duplicates", () => {
    expect(normalizeModes("messages-tuple")).toEqual(["messages"]);
    expect(normalizeModes(["values", "values", "updates"])).toEqual(["values", "updates"]);
  });

  it("preserves `events` (the engine drives it via streamEvents, not streamMode)", () => {
    expect(normalizeModes(["events"])).toEqual(["events"]);
    expect(wantsEventsMode(["events", "values"])).toBe(true);
    expect(wantsEventsMode(["values"])).toBe(false);
    // `events` is stripped from the graph-level streamMode.
    expect(toGraphStreamModes(["events", "values"])).toEqual(["values"]);
    expect(toGraphStreamModes(["events"])).toEqual([]);
  });
});

describe("toGraphInput", () => {
  it("builds a Command when the run carries one", () => {
    const input = toGraphInput({ command: { resume: "yes" } });
    expect(isCommand(input)).toBe(true);
  });

  it("passes input through, defaulting to null", () => {
    expect(toGraphInput({ input: { value: "hi" } })).toEqual({ value: "hi" });
    expect(toGraphInput({})).toBeNull();
  });
});

describe("toGraphCallOptions", () => {
  it("threads thread_id through configurable and always wins over caller config", () => {
    const signal = new AbortController().signal;
    const options = toGraphCallOptions(
      { config: { configurable: { thread_id: "other", foo: "bar" } }, stream_mode: "values" },
      "t1",
      signal,
    );
    expect(options.configurable).toEqual({ foo: "bar", thread_id: "t1" });
    expect(options.streamMode).toEqual(["values"]);
    expect(options.signal).toBe(signal);
  });

  it("strips server-owned configurable keys a client must not set", () => {
    const options = toGraphCallOptions(
      {
        config: {
          configurable: {
            user_key: "ok",
            checkpoint_id: "attacker-picked",
            checkpoint_ns: "x",
            run_id: "spoof",
            __pregel_internal: "no",
          },
        },
      },
      "t1",
      new AbortController().signal,
    );
    expect(options.configurable).toEqual({ user_key: "ok", thread_id: "t1" });
  });

  it("carries context, recursion limit, and interrupt lists when present", () => {
    const options = toGraphCallOptions(
      {
        context: { user: "a" },
        config: { recursion_limit: 5 },
        interrupt_before: ["ask"],
        interrupt_after: "*",
      },
      "t1",
      new AbortController().signal,
    );
    expect(options.context).toEqual({ user: "a" });
    expect(options.recursionLimit).toBe(5);
    expect(options.interruptBefore).toEqual(["ask"]);
    expect(options.interruptAfter).toBe("*");
  });

  it("injects the authenticated caller (with custom fields) as langgraph_auth_* keys", () => {
    const options = toGraphCallOptions(
      {
        auth_user: {
          identity: "user-1",
          display_name: "user-1",
          is_authenticated: true,
          permissions: ["read"],
          workspaceId: "ws-9",
        },
      },
      "t1",
      new AbortController().signal,
    );
    expect(options.configurable).toEqual({
      thread_id: "t1",
      langgraph_auth_user: {
        identity: "user-1",
        display_name: "user-1",
        is_authenticated: true,
        permissions: ["read"],
        workspaceId: "ws-9",
      },
      langgraph_auth_user_id: "user-1",
      langgraph_auth_permissions: ["read"],
    });
  });

  it("sources langgraph_auth_permissions from the caller's scopes, not user.permissions", () => {
    const options = toGraphCallOptions(
      {
        auth_user: {
          identity: "user-1",
          display_name: "user-1",
          is_authenticated: true,
          permissions: ["ui:read"],
        },
        auth_scopes: ["run:write"],
      },
      "t1",
      new AbortController().signal,
    );
    expect(options.configurable.langgraph_auth_permissions).toEqual(["run:write"]);
  });

  it("injects no auth keys when the run carries no principal (no auth configured)", () => {
    const options = toGraphCallOptions(
      { config: { configurable: { foo: "bar" } } },
      "t1",
      new AbortController().signal,
    );
    expect(options.configurable).toEqual({ foo: "bar", thread_id: "t1" });
  });

  it("ignores a client-supplied langgraph_auth_user — the server principal always wins", () => {
    const options = toGraphCallOptions(
      {
        config: {
          configurable: {
            langgraph_auth_user: { identity: "attacker" },
            langgraph_auth_user_id: "attacker",
            langgraph_auth_permissions: ["admin"],
          },
        },
        auth_user: {
          identity: "real-user",
          display_name: "real-user",
          is_authenticated: true,
          permissions: [],
        },
      },
      "t1",
      new AbortController().signal,
    );
    expect(options.configurable.langgraph_auth_user_id).toBe("real-user");
    expect(options.configurable.langgraph_auth_permissions).toEqual([]);
    expect((options.configurable.langgraph_auth_user as { identity: string }).identity).toBe(
      "real-user",
    );
  });
});

describe("toFactoryConfigurable", () => {
  const user = {
    identity: "user-1",
    display_name: "user-1",
    is_authenticated: true,
    permissions: [],
  };

  it("strips server-owned keys so a factory can't be fed a spoofed principal", () => {
    const configurable = toFactoryConfigurable({
      config: {
        configurable: {
          keep: "me",
          checkpoint_id: "attacker-picked",
          langgraph_auth_user: { identity: "attacker" },
          __internal: "no",
        },
      },
      auth_user: user,
      auth_scopes: ["run:write"],
    });
    expect(configurable).toEqual({
      keep: "me",
      langgraph_auth_user: user,
      langgraph_auth_user_id: "user-1",
      langgraph_auth_permissions: ["run:write"],
    });
  });

  it("returns undefined when a run carries no config and no principal", () => {
    expect(toFactoryConfigurable({})).toBeUndefined();
    expect(toFactoryConfigurable({ config: { configurable: {} } })).toBeUndefined();
  });
});
