import { createSpecStreamCompiler, type Spec } from "@json-render/core";
import { expect, it, vi } from "vitest";

import { validateGeneratedUi } from "./catalog.js";
import { fixtureSpecStream } from "./generation-fixture.js";
import { generateModelText } from "./generation.js";

vi.mock("@skein-js/example-github-playground", () => ({
  async *streamGitHubUi() {
    const patches = fixtureSpecStream({ prompt: "A repository dashboard" }).split("\n");
    const wrapped = "```json\n[\n" + patches.join(",\n") + "\n]\n```";
    for (let offset = 0; offset < wrapped.length; offset += 53)
      yield wrapped.slice(offset, offset + 53);
  },
}));

it("compiles streamed patches when the model writes array separators", async () => {
  const compiler = createSpecStreamCompiler<Spec>();
  for await (const text of generateModelText({ prompt: "A repository dashboard" }))
    compiler.push(text);
  const ui = validateGeneratedUi(compiler.getResult());
  expect(ui.elements["revise"]?.on?.["press"]).toBeDefined();
  expect(ui.elements["feedback"]?.on?.["submit"]).toBeDefined();
});
