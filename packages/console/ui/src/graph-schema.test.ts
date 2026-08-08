import { describe, expect, it } from "vitest";

import { acceptsMessages, sampleInputFor } from "./graph-schema";

describe("acceptsMessages", () => {
  it("reads the shape the SDK documents", () => {
    expect(
      acceptsMessages({
        graph_id: "chat",
        input_schema: { type: "object", properties: { messages: { type: "array" } } },
      }),
    ).toBe(true);
  });

  it("reads the shape skein actually sends", () => {
    // A map of graph symbol → { state, input, output, config }. See the note in graph-schema.ts:
    // this is a live divergence from the SDK's typed response, not a legacy shape.
    expect(
      acceptsMessages({
        graph: {
          state: { type: "object", properties: { messages: { type: "array" } } },
          input: { type: "object", properties: { messages: { type: "array" } } },
          output: {},
          config: {},
        },
      }),
    ).toBe(true);
  });

  it("is false for a graph with a different input", () => {
    expect(
      acceptsMessages({
        graph: { input: { type: "object", properties: { repo: { type: "string" } } } },
      }),
    ).toBe(false);
  });

  it("falls back to false for anything it does not recognize", () => {
    // The JSON editor is the safe default: a chat box in front of a graph that wants
    // `{ repo, limit }` fails worse than an editor in front of a chatbot.
    expect(acceptsMessages(undefined)).toBe(false);
    expect(acceptsMessages(null)).toBe(false);
    expect(acceptsMessages("nope")).toBe(false);
    expect(acceptsMessages({})).toBe(false);
    expect(acceptsMessages({ graph: { input: null } })).toBe(false);
  });
});

describe("sampleInputFor", () => {
  it("resolves a $ref so the template is valid input, not a null placeholder", () => {
    // LangGraph's introspection describes a nested object as a $ref into `definitions` and omits
    // `type` on the target. Not following it emitted `{"item": null}` — and pressing Send on the
    // console's own default answered `Expected object, received null`.
    const schemas = {
      graph: {
        input: {
          type: "object",
          properties: { item: { $ref: "#/definitions/Item" }, limit: { type: "number" } },
          definitions: {
            Item: {
              properties: {
                sourceId: { type: "string" },
                labels: { type: "array" },
                urgent: { type: "boolean" },
              },
            },
          },
        },
      },
    };
    expect(JSON.parse(sampleInputFor(schemas))).toEqual({
      item: { sourceId: "", labels: [], urgent: false },
      limit: 0,
    });
  });

  it("does not recurse forever on a self-referential schema", () => {
    const schemas = {
      graph: {
        input: {
          properties: { node: { $ref: "#/definitions/Node" } },
          definitions: {
            Node: {
              properties: { name: { type: "string" }, child: { $ref: "#/definitions/Node" } },
            },
          },
        },
      },
    };
    expect(JSON.parse(sampleInputFor(schemas))).toEqual({ node: { name: "", child: {} } });
  });

  it("samples a union by its first branch and an enum by its first value", () => {
    const schemas = {
      graph: {
        input: {
          properties: {
            mode: { enum: ["fast", "slow"] },
            payload: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
        },
      },
    };
    expect(JSON.parse(sampleInputFor(schemas))).toEqual({ mode: "fast", payload: "" });
  });

  it("falls back to an empty object when there is no schema to read", () => {
    expect(sampleInputFor(undefined)).toBe("{}");
    expect(sampleInputFor({ graph: { input: {} } })).toBe("{}");
  });
});
