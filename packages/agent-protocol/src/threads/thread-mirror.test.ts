import type { StateSnapshot } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import {
  collectInterrupts,
  isInterruptedSnapshot,
  runStatusForSnapshot,
  snapshotToThreadState,
  snapshotToThreadUpdate,
} from "./thread-mirror.js";

const snapshot = (over: Partial<StateSnapshot>): StateSnapshot =>
  ({
    values: {},
    next: [],
    tasks: [],
    config: { configurable: { thread_id: "t1" } },
    metadata: {},
    ...over,
  }) as unknown as StateSnapshot;

const task = (id: string, interrupts: unknown[]) =>
  ({ id, name: id, interrupts }) as unknown as StateSnapshot["tasks"][number];

describe("isInterruptedSnapshot / runStatusForSnapshot", () => {
  it("is interrupted when the graph has work left in `next`", () => {
    expect(isInterruptedSnapshot(snapshot({ next: ["ask"] }))).toBe(true);
    expect(runStatusForSnapshot(snapshot({ next: ["ask"] }))).toBe("interrupted");
  });

  it("is a success when nothing is left to run", () => {
    expect(isInterruptedSnapshot(snapshot({ next: [] }))).toBe(false);
    expect(runStatusForSnapshot(snapshot({ next: [] }))).toBe("success");
  });
});

describe("collectInterrupts", () => {
  it("keys pending interrupts by their task id", () => {
    const snap = snapshot({ tasks: [task("taskA", [{ value: "approve?" }]), task("taskB", [])] });
    expect(collectInterrupts(snap)).toEqual({ taskA: [{ value: "approve?" }] });
  });
});

describe("snapshotToThreadUpdate", () => {
  it("mirrors values, interrupts, and the thread status", () => {
    const snap = snapshot({
      values: { value: "hi" },
      next: ["ask"],
      tasks: [task("taskA", [{ value: "approve?" }])],
    });
    expect(snapshotToThreadUpdate(snap, "interrupted")).toEqual({
      values: { value: "hi" },
      interrupts: { taskA: [{ value: "approve?" }] },
      status: "interrupted",
    });
  });
});

describe("snapshotToThreadState", () => {
  it("maps a snapshot to the wire thread state, including the checkpoint id", () => {
    const snap = snapshot({
      values: { value: "hi" },
      next: [],
      config: { configurable: { thread_id: "t1", checkpoint_id: "c1", checkpoint_ns: "" } },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const state = snapshotToThreadState(snap);
    expect(state.values).toEqual({ value: "hi" });
    expect(state.checkpoint).toEqual({
      thread_id: "t1",
      checkpoint_ns: "",
      checkpoint_id: "c1",
      checkpoint_map: undefined,
    });
    expect(state.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(state.parent_checkpoint).toBeNull();
  });

  it("renders a failed task's error as JSON, not [object Object]", () => {
    // LangGraph records a task failure as an object, so `String()` produced "[object Object]" —
    // and the SDK's `useStream` JSON.parses this field to rebuild a `StreamError` from it.
    const failed = {
      id: "taskA",
      name: "call_model",
      interrupts: [],
      error: { name: "Error", message: "boom" },
    } as unknown as StateSnapshot["tasks"][number];

    const [rendered] = snapshotToThreadState(snapshot({ tasks: [failed] })).tasks;
    expect(rendered?.error).toBe('{"name":"Error","message":"boom"}');
    expect(JSON.parse(rendered?.error ?? "null")).toMatchObject({ message: "boom" });
  });

  it("passes a string task error through untouched and leaves a healthy task null", () => {
    const asString = {
      id: "taskA",
      name: "call_model",
      interrupts: [],
      error: "already a string",
    } as unknown as StateSnapshot["tasks"][number];

    expect(snapshotToThreadState(snapshot({ tasks: [asString] })).tasks[0]?.error).toBe(
      "already a string",
    );
    expect(
      snapshotToThreadState(snapshot({ tasks: [task("taskB", [])] })).tasks[0]?.error,
    ).toBeNull();
  });
});
