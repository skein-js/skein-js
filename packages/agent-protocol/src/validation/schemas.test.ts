import { describe, expect, it } from "vitest";

import { parse, requireParam } from "./parse.js";
import {
  runCreateSchema,
  storePutSchema,
  threadCreateSchema,
  threadStateUpdateSchema,
} from "./schemas.js";

describe("validation", () => {
  it("accepts a valid run-create body", () => {
    const parsed = parse(runCreateSchema, { assistant_id: "echo", input: { value: "hi" } });
    expect(parsed.assistant_id).toBe("echo");
  });

  it("rejects a run-create body missing assistant_id with a 400", () => {
    expect(() => parse(runCreateSchema, { input: {} })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("rejects a store put with an empty namespace or key", () => {
    expect(() => parse(storePutSchema, { namespace: [], key: "k", value: {} })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parse(storePutSchema, { namespace: ["ns"], key: "", value: {} })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("allows an empty thread-create body", () => {
    expect(parse(threadCreateSchema, {})).toEqual({});
  });

  it("requireParam throws a 400 when a path param is missing", () => {
    expect(() => requireParam({}, "thread_id")).toThrow(expect.objectContaining({ status: 400 }));
    expect(requireParam({ thread_id: "t1" }, "thread_id")).toBe("t1");
  });

  it("accepts a run-create body with a time-travel checkpoint_id", () => {
    const parsed = parse(runCreateSchema, { assistant_id: "echo", checkpoint_id: "ckpt-1" });
    expect(parsed.checkpoint_id).toBe("ckpt-1");
  });

  it("accepts a thread state-update body and its fork fields", () => {
    const parsed = parse(threadStateUpdateSchema, {
      values: { value: "x" },
      as_node: "echo",
      checkpoint_id: "ckpt-1",
    });
    expect(parsed).toMatchObject({ as_node: "echo", checkpoint_id: "ckpt-1" });
    // A null values (re-point next without changing values) and an empty body are both valid.
    expect(parse(threadStateUpdateSchema, { values: null })).toEqual({ values: null });
    expect(parse(threadStateUpdateSchema, {})).toEqual({});
  });

  it("rejects a non-string as_node / checkpoint_id in a state-update body", () => {
    expect(() => parse(threadStateUpdateSchema, { as_node: 5 })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parse(threadStateUpdateSchema, { checkpoint_id: 5 })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("strips server-owned identity keys smuggled through the checkpoint pointer", () => {
    // The checkpoint object is spread into the graph's `configurable`; a client must not be able to
    // redirect the write by smuggling a `thread_id` (or run/auth keys) through it.
    const parsed = parse(threadStateUpdateSchema, {
      values: { value: "x" },
      checkpoint: {
        checkpoint_id: "c1",
        thread_id: "victim-thread",
        run_id: "r1",
        langgraph_auth_user: { identity: "attacker" },
      },
    });
    expect(parsed.checkpoint).toEqual({ checkpoint_id: "c1" });
  });
});
