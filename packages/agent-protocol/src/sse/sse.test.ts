import type { RunFrame } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { encodeFrame, encodeTerminal, parseAfterSeq, toSseEvents } from "./sse.js";

describe("encodeFrame", () => {
  it("formats id, event, and JSON data", () => {
    expect(encodeFrame({ seq: 2, event: "values", data: { a: 1 } })).toBe(
      `id: 2\nevent: values\ndata: {"a":1}\n\n`,
    );
  });

  it("keeps a multi-line stack inside one SSE block", () => {
    // SSE delimits on a blank line, so a raw newline in the payload would split one frame into two
    // and desynchronize the client. JSON.stringify escapes them — pinned, because `exposeErrorStacks`
    // is what first put multi-line text on this wire.
    const encoded = encodeFrame({
      seq: 1,
      event: "error",
      data: {
        error: "Error",
        name: "Error",
        message: "boom",
        stack: "Error: boom\n    at callModel (/app/src/graph.ts:42:11)",
        cause: { error: "Error", name: "Error", message: "429\nrate limit" },
      },
    });

    // One trailing blank line, and no other blank line to be mistaken for a frame boundary.
    expect(encoded.endsWith("\n\n")).toBe(true);
    expect(encoded.slice(0, -2)).not.toContain("\n\n");
    expect(encoded.split("\n").filter((line) => line.startsWith("data: "))).toHaveLength(1);
  });
});

describe("encodeTerminal", () => {
  it("uses `end` for success/interrupted and `error` for error/timeout", () => {
    expect(encodeTerminal("success")).toContain("event: end");
    expect(encodeTerminal("interrupted")).toContain("event: end");
    expect(encodeTerminal("error")).toContain("event: error");
    expect(encodeTerminal("timeout")).toContain("event: error");
  });
});

describe("parseAfterSeq", () => {
  it("parses a valid id, and defaults missing/invalid to 0", () => {
    expect(parseAfterSeq("5")).toBe(5);
    expect(parseAfterSeq(undefined)).toBe(0);
    expect(parseAfterSeq("abc")).toBe(0);
    expect(parseAfterSeq("-3")).toBe(0);
    expect(parseAfterSeq("0")).toBe(0);
  });
});

describe("toSseEvents", () => {
  it("serializes each frame then a synthesized terminal event", async () => {
    async function* frames(): AsyncIterable<RunFrame> {
      yield { seq: 1, event: "values", data: 1 };
      yield { seq: 2, event: "values", data: 2 };
    }
    const out: string[] = [];
    for await (const chunk of toSseEvents(frames(), async () => "success")) out.push(chunk);

    expect(out).toHaveLength(3);
    expect(out[0]).toContain("id: 1");
    expect(out[2]).toContain("event: end");
  });

  it("ends with an error event when the run failed", async () => {
    async function* frames(): AsyncIterable<RunFrame> {
      yield { seq: 1, event: "error", data: { message: "boom" } };
    }
    const out: string[] = [];
    for await (const chunk of toSseEvents(frames(), async () => "error")) out.push(chunk);

    expect(out.at(-1)).toContain("event: error");
  });
});

describe("encodeFrame caching", () => {
  it("returns the identical string for a frame it has already encoded", () => {
    // The in-process bus hands one frame object to every subscriber on a run, which is what makes this
    // worth caching at all.
    const frame = { seq: 1, event: "values", data: { a: 1 } } as const;

    const first = encodeFrame(frame);
    const second = encodeFrame(frame);

    expect(second).toBe(first);
  });

  it("encodes distinct frame objects independently, even when structurally equal", () => {
    // Keyed by object identity, so two equal-looking frames must not share an entry — a `seq`-keyed
    // cache would collide across runs.
    const encoded = encodeFrame({ seq: 1, event: "values", data: { a: 1 } });
    const other = encodeFrame({ seq: 1, event: "values", data: { a: 2 } });

    expect(other).not.toBe(encoded);
    expect(other).toContain('"a":2');
  });
});
