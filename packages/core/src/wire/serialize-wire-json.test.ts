import { describe, expect, it } from "vitest";

import { serializeWireJson } from "./serialize-wire-json.js";

// A stand-in for a LangChain message: the only contract `serializeWireJson` cares about is a
// `toDict()` returning `{ type, data }` (what every `BaseMessage` exposes). Crucially it also has a
// `toJSON()` that produces the unwanted constructor form — the serializer must ignore it.
class FakeMessage {
  constructor(private readonly content: string) {}
  toDict() {
    return { type: "ai", data: { content: this.content, additional_kwargs: {} } };
  }

  toJSON() {
    return { lc: 1, type: "constructor", id: ["langchain_core", "messages", "AIMessage"] };
  }
}

describe("serializeWireJson", () => {
  it("flattens a message to `{ ...data, type }`, not its constructor form", () => {
    const out = JSON.parse(serializeWireJson(new FakeMessage("hello")));
    expect(out).toEqual({ content: "hello", additional_kwargs: {}, type: "ai" });
  });

  it("flattens messages nested inside state values", () => {
    const out = JSON.parse(
      serializeWireJson({ messages: [new FakeMessage("a"), new FakeMessage("b")] }),
    );
    expect(out.messages.map((m: { content: string }) => m.content)).toEqual(["a", "b"]);
    expect(out.messages.every((m: { type: string }) => m.type === "ai")).toBe(true);
  });

  it("leaves ordinary values (including Dates) serialized normally", () => {
    const date = new Date("2026-07-14T00:00:00.000Z");
    const out = JSON.parse(serializeWireJson({ n: 1, s: "x", nested: { ok: true }, date }));
    expect(out).toEqual({ n: 1, s: "x", nested: { ok: true }, date: "2026-07-14T00:00:00.000Z" });
  });
});
