import { describe, expect, it } from "vitest";

import { renderTemplate } from "./render-template.js";

describe("renderTemplate", () => {
  it("rejects an unknown template rather than emitting nothing", () => {
    expect(() => renderTemplate("no/such/template", {})).toThrow(/No template named/);
  });

  // EJS evaluates in a `with` block, so a name the caller forgot is a ReferenceError. Keeping that
  // as a throw is deliberate: a typo in a placeholder should fail the build, not put an empty string
  // into someone's starter project.
  it("rejects a template whose values are missing", () => {
    expect(() => renderTemplate("src/agent-graph.ts", {})).toThrow(
      /Failed to render template "src\/agent-graph\.ts"/,
    );
  });

  it("does not HTML-escape — this generates code, not markup", () => {
    const rendered = renderTemplate("src/agent-graph.ts", {
      modelClass: "ChatOpenAI",
      modelPackage: "@langchain/openai",
      apiKeyEnvVar: "OPENAI_API_KEY",
      providerConsoleUrl: "https://example.com/keys?a=1&b=2",
      modelEnvVar: "OPENAI_MODEL",
      defaultModel: "gpt-4.1-mini",
    });

    expect(rendered).toContain("https://example.com/keys?a=1&b=2");
    expect(rendered).not.toContain("&amp;");
  });

  describe("conditionals", () => {
    const withProvider = {
      hasProvider: true,
      providerConsoleUrl: "https://x",
      apiKeyEnvVar: "K",
      modelEnvVar: "M",
      defaultModel: "m",
    };
    const withoutProvider = { ...withProvider, hasProvider: false };

    // Inline form: the newline after the closing tag is real content, and dropping it would put the
    // JSON's closing brace on the previous line.
    it("keeps an inline block's surrounding structure intact either way", () => {
      expect(JSON.parse(renderTemplate("langgraph.json", withProvider)).graphs).toEqual({
        echo: "./src/echo-graph.ts:graph",
        agent: "./src/agent-graph.ts:graph",
      });
      expect(JSON.parse(renderTemplate("langgraph.json", withoutProvider)).graphs).toEqual({
        echo: "./src/echo-graph.ts:graph",
      });
    });

    // Block form: `<%_ … _%>` slurps the tag lines, so an omitted section leaves no blank hole.
    it("leaves no stray blank lines when a block is dropped", () => {
      const rendered = renderTemplate("env.example", withoutProvider);
      expect(rendered).not.toContain("API_KEY");
      expect(rendered).not.toMatch(/\n\n\n/);
    });
  });
});
