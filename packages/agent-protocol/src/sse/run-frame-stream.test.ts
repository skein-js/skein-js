import { describe, expect, it } from "vitest";

import { chunkToFrameBody, streamEventToFrameBody, toRunFrame } from "./run-frame-stream.js";

describe("chunkToFrameBody", () => {
  it("unwraps a [mode, data] tuple", () => {
    expect(chunkToFrameBody(["values", { a: 1 }])).toEqual({
      event: "values",
      namespace: [],
      data: { a: 1 },
    });
    expect(chunkToFrameBody(["messages", "hi"])).toEqual({
      event: "messages",
      namespace: [],
      data: "hi",
    });
  });

  it("treats a bare (non-tuple) chunk as an updates payload", () => {
    expect(chunkToFrameBody({ x: 1 })).toEqual({ event: "updates", namespace: [], data: { x: 1 } });
  });

  it("only unwraps tuples whose first element is a known mode", () => {
    expect(chunkToFrameBody(["nope", 1])).toEqual({
      event: "updates",
      namespace: [],
      data: ["nope", 1],
    });
  });

  it("names a root triple by its mode alone", () => {
    // With subgraphs on, LangGraph sends the run's own frames as triples with an empty namespace.
    expect(chunkToFrameBody([[], "updates", { a: 1 }], true)).toEqual({
      event: "updates",
      namespace: [],
      data: { a: 1 },
    });
  });

  it("preserves a subgraph triple namespace separately from its mode", () => {
    expect(chunkToFrameBody([["tools:call-1"], "updates", { a: 1 }], true)).toEqual({
      event: "updates",
      namespace: ["tools:call-1"],
      data: { a: 1 },
    });
    expect(
      chunkToFrameBody([["tools:call-1", "model_request:m-2"], "messages", ["chunk"]], true),
    ).toEqual({
      event: "messages",
      namespace: ["tools:call-1", "model_request:m-2"],
      data: ["chunk"],
    });
    expect(chunkToFrameBody([["agent:a-1"], "custom", { progress: 1 }], true).event).toBe("custom");
  });

  it("does not unwrap a triple whose namespace or mode is malformed", () => {
    expect(chunkToFrameBody([["tools:1"], "nope", 1], true).event).toBe("updates");
    expect(chunkToFrameBody([[1], "updates", 1], true).event).toBe("updates");
    expect(chunkToFrameBody(["tools:1", "updates", 1], true).event).toBe("updates");
  });

  it("preserves bare arrays shaped like triples unless subgraph streaming was requested", () => {
    const chunk = [["application"], "values", { value: 1 }];
    const original = { event: "updates", namespace: [], data: chunk };
    expect(chunkToFrameBody(chunk)).toEqual(original);
    expect(chunkToFrameBody(chunk, false)).toEqual(original);
    expect(chunkToFrameBody(chunk, true)).toEqual({
      event: "values",
      namespace: ["application"],
      data: { value: 1 },
    });
  });
});

describe("streamEventToFrameBody", () => {
  const runId = "run-1";

  it("turns this run's on_chain_stream pair into a mode frame when the mode was requested", () => {
    const event = {
      event: "on_chain_stream",
      run_id: runId,
      data: { chunk: ["values", { a: 1 }] },
    };
    expect(streamEventToFrameBody(event, runId, ["values"])).toEqual({
      event: "values",
      namespace: [],
      data: { a: 1 },
    });
    expect(streamEventToFrameBody(event, runId, ["updates"])).toBeNull();
  });

  it("without subgraphs, passes another run's on_chain_stream through as an events frame", () => {
    const event = { event: "on_chain_stream", run_id: "child", data: { chunk: ["values", 1] } };
    expect(streamEventToFrameBody(event, runId, ["values"])).toEqual({
      event: "events",
      namespace: [],
      data: event,
    });
  });

  it("with subgraphs, turns the root run's triples into mode frames with their namespace", () => {
    // The root's stream relays every subgraph's chunk under its real namespace.
    const relayed = {
      event: "on_chain_stream",
      run_id: runId,
      data: { chunk: [["tools:call-1"], "updates", { a: 1 }] },
    };
    const own = { event: "on_chain_stream", run_id: runId, data: { chunk: [[], "updates", 2] } };
    expect(streamEventToFrameBody(relayed, runId, ["updates"], true)).toEqual({
      event: "updates",
      namespace: ["tools:call-1"],
      data: { a: 1 },
    });
    expect(streamEventToFrameBody(own, runId, ["updates"], true)).toEqual({
      event: "updates",
      namespace: [],
      data: 2,
    });
    expect(streamEventToFrameBody(relayed, runId, ["values"], true)).toBeNull();
  });

  it("with subgraphs, never reads a nested run's own triple as a mode frame", () => {
    // A graph a tool streams itself with `subgraphs` emits chunks namespaced relative to *itself* —
    // `[]` here. Read as a mode frame it would masquerade as the root's state, or repeat a frame the
    // root already relayed under its real namespace.
    const nested = {
      event: "on_chain_stream",
      run_id: "nested-run",
      data: { chunk: [[], "values", { spoofed: "root state" }] },
    };
    expect(streamEventToFrameBody(nested, runId, ["values"], true)).toEqual({
      event: "events",
      namespace: [],
      data: nested,
    });
  });

  it("does not read a namespace segment that could break the SSE event line", () => {
    for (const segment of ["tools:1\nevent: end", "tools:1\r", "tools:1|forged"]) {
      const event = {
        event: "on_chain_stream",
        run_id: runId,
        data: { chunk: [[segment], "updates", 1] },
      };
      expect(streamEventToFrameBody(event, runId, ["updates"], true)?.event).toBe("events");
      expect(chunkToFrameBody([[segment], "updates", 1], true)).toEqual({
        event: "updates",
        namespace: [],
        data: [[segment], "updates", 1],
      });
    }
  });

  it("accepts root pairs when a runner ignores subgraphs, keeping child pairs as raw events", () => {
    const root = { event: "on_chain_stream", run_id: runId, data: { chunk: ["values", 1] } };
    expect(streamEventToFrameBody(root, runId, ["values"], true)).toEqual({
      event: "values",
      namespace: [],
      data: 1,
    });
    expect(streamEventToFrameBody(root, runId, ["updates"], true)).toBeNull();
    const child = { ...root, run_id: "child" };
    expect(streamEventToFrameBody(child, runId, ["values"], true)).toEqual({
      event: "events",
      namespace: [],
      data: child,
    });
  });

  it("keeps unrecognized stream chunks as raw events", () => {
    const event = { event: "on_chain_stream", run_id: runId, data: { chunk: { a: 1 } } };
    expect(streamEventToFrameBody(event, runId, ["updates"], true)?.data).toEqual(event);
  });

  it("drops hidden events and passes every other event through as an events frame", () => {
    expect(
      streamEventToFrameBody({ event: "on_llm_stream", tags: ["langsmith:hidden"] }, runId, []),
    ).toBeNull();
    expect(streamEventToFrameBody({ event: "on_tool_start" }, runId, [], true)?.event).toBe(
      "events",
    );
  });
});

describe("toRunFrame", () => {
  it("stamps the sequence number onto a frame body", () => {
    expect(toRunFrame(3, { event: "messages", namespace: [], data: "x" })).toEqual({
      seq: 3,
      event: "messages",
      data: "x",
    });
  });

  it("carries a separate namespace onto the frame", () => {
    expect(toRunFrame(4, chunkToFrameBody([["tools:1"], "updates", 1], true))).toEqual({
      seq: 4,
      event: "updates",
      namespace: ["tools:1"],
      data: 1,
    });
  });
});
