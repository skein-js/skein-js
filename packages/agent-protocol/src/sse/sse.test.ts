import type { RunFrame } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { encodeFrame, encodeTerminal, parseAfterSeq, toSseEvents } from "./sse.js";

describe("encodeFrame", () => {
  it("formats id, event, and JSON data", () => {
    expect(encodeFrame({ seq: 2, event: "values", data: { a: 1 } })).toBe(
      `id: 2\nevent: values\ndata: {"a":1}\n\n`,
    );
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
