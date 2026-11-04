import { compileSpecStream } from "@json-render/core";
import { describe, expect, it } from "vitest";

import { validateUiSpec, type CommittedUi } from "./catalog.js";
import { demoSpecStream } from "./generation.js";
import { createUiStream, type StreamFrame, type UiEvent } from "./ui-events.js";

const generationId = "32cf59ea-785c-43eb-81ce-f936d533d956";
const otherGeneration = "7f4aa0d1-6602-49a5-b128-06ac9aad4450";
const text = demoSpecStream({ prompt: "Plan a café visit ☕ 🌱" });
const expected = validateUiSpec(compileSpecStream(text));
const baseline: CommittedUi = { spec: expected, generationId: otherGeneration, chunkCount: 1 };
const frame = (event: UiEvent, namespace = "custom"): StreamFrame => ({
  event: namespace,
  data: event,
});

function events(size = 43): UiEvent[] {
  const result: UiEvent[] = [{ type: "json-render", generationId, sequence: 0, phase: "start" }];
  for (let offset = 0; offset < text.length; offset += size)
    result.push({
      type: "json-render",
      generationId,
      sequence: result.length,
      phase: "chunk",
      text: text.slice(offset, offset + size),
    });
  result.push({ type: "json-render", generationId, sequence: result.length, phase: "complete" });
  return result;
}

describe("application SpecStream bridge", () => {
  it.each([1, 17, 5000])(
    "buffers arbitrary chunks of %i characters and flushes the final line",
    (size) => {
      const stream = createUiStream(null);
      for (const event of events(size)) stream.push(frame(event));
      expect(stream.snapshot()).toMatchObject({ complete: true, gap: false, spec: expected });
    },
  );

  it("deduplicates replay before non-idempotent array inserts reach the compiler", () => {
    const stream = createUiStream(null);
    for (const event of events()) {
      stream.push(frame(event));
      stream.push(frame(event));
    }
    expect(stream.snapshot().spec).toEqual(expected);
    expect(stream.snapshot().spec?.elements["tasks"]?.props["tasks"]).toHaveLength(3);
  });

  it.each(["prefix", "interior", "order"])(
    "abandons a preview after a missing or reordered %s",
    (loss) => {
      const stream = createUiStream(baseline);
      const chunks = events();
      const damaged =
        loss === "prefix"
          ? chunks.slice(1)
          : loss === "interior"
            ? chunks.filter((_, index) => index !== 3)
            : [chunks[0]!, chunks[2]!, chunks[1]!, ...chunks.slice(3)];
      for (const event of damaged) stream.push(frame(event));
      expect(stream.snapshot()).toMatchObject({ gap: true, spec: expected, complete: false });
    },
  );

  it("keeps the committed baseline intact while nested arrays change in a preview", () => {
    const original = structuredClone(baseline);
    const stream = createUiStream(baseline);
    for (const event of events()) stream.push(frame(event));
    const rendered = stream.snapshot();
    rendered.spec!.elements["tasks"]!.props["tasks"] = ["changed by renderer"];
    expect(stream.snapshot().spec).toEqual(expected);
    expect(baseline).toEqual(original);
  });

  it("ignores other modes, subgraphs, unrelated custom events and another generation", () => {
    const stream = createUiStream(null);
    for (const event of events()) {
      stream.push(frame(event, "custom|worker:123"));
      stream.push(frame(event, "messages"));
      stream.push({ event: "custom", data: { progress: "working" } });
      stream.push(frame(event));
      stream.push(frame({ ...event, generationId: otherGeneration }));
    }
    expect(stream.snapshot()).toMatchObject({ gap: false, complete: true, spec: expected });
  });

  it("does not treat a truncated tail as a completed specification", () => {
    const stream = createUiStream(baseline);
    for (const event of events().slice(0, -2)) stream.push(frame(event));
    expect(stream.snapshot().complete).toBe(false);
  });

  it("falls back on malformed application envelopes and invalid final specifications", () => {
    const stream = createUiStream(baseline);
    stream.push({ event: "custom", data: { type: "json-render", phase: "chunk" } });
    expect(stream.snapshot()).toMatchObject({ gap: true, spec: expected });
    const invalid = createUiStream(baseline);
    invalid.push(frame({ type: "json-render", generationId, sequence: 0, phase: "start" }));
    invalid.push(
      frame({
        type: "json-render",
        generationId,
        sequence: 1,
        phase: "chunk",
        text: "not a specification",
      }),
    );
    invalid.push(frame({ type: "json-render", generationId, sequence: 2, phase: "complete" }));
    expect(invalid.snapshot()).toMatchObject({ gap: true, spec: expected });
  });

  it("rejects unknown actions and action chains through upstream binding validation", () => {
    const unknownAction = structuredClone(expected);
    unknownAction.elements["revise"]!.on = { press: { action: "approvePlan" } };
    expect(() => validateUiSpec(unknownAction)).toThrow();
    const navigation = structuredClone(expected);
    navigation.elements["revise"]!.on = {
      press: { action: "revisePlan", onSuccess: { navigate: "https://example.com" } },
    };
    expect(() => validateUiSpec(navigation)).toThrow();
  });
});
