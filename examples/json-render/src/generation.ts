import { streamGitHubUi } from "@skein-js/example-github-playground";

import { catalog, type CommittedUi, type PromptRequest } from "./catalog.js";

export type GenerateText = (
  request: PromptRequest,
  signal?: AbortSignal,
  previousUi?: CommittedUi | null,
) => AsyncIterable<string>;

const systemPrompt = catalog.prompt({
  customRules: [
    "Build a fresh, compact view on every turn. Use a Card as the root with the exact GitHub login or owner/name as its title when known. Include only the facts requested or needed for that view.",
    "Start with /root. Emit one complete add patch per element, with one JSON object per line. Each element has type, props, and children. Put all component fields inside props, including Grid columns. Every child key must name an element emitted in this turn.",
    "Use literal props and strings for every table cell. Omit state, dynamic expressions, and event bindings. Put a Button with label and prompt, and a FeedbackForm with label, directly under the root Card. The app binds their actions.",
    `Follow this SpecStream shape, replacing the example title and content with the requested GitHub view:
{"op":"add","path":"/root","value":"view"}
{"op":"add","path":"/elements/view","value":{"type":"Card","props":{"title":"owner/repository"},"children":["summary","metrics","revise","feedback"]}}
{"op":"add","path":"/elements/summary","value":{"type":"Text","props":{"text":"Repository description"},"children":[]}}
{"op":"add","path":"/elements/metrics","value":{"type":"Grid","props":{"columns":1},"children":["metric"]}}
{"op":"add","path":"/elements/metric","value":{"type":"Metric","props":{"label":"Language","value":"Primary language","detail":"Repository language"},"children":[]}}
{"op":"add","path":"/elements/revise","value":{"type":"Button","props":{"label":"Make it simpler","prompt":"Make this GitHub view simpler"},"children":[]}}
{"op":"add","path":"/elements/feedback","value":{"type":"FeedbackForm","props":{"label":"What would you change?"},"children":[]}}`,
  ],
});

export const generateModelText: GenerateText = async function* (request, signal, previousUi) {
  const chunks = streamGitHubUi({
    modelSetting: "JSON_RENDER_MODEL",
    prompt: request.prompt,
    previousUi: previousUi?.spec ?? null,
    signal,
    systemPrompt,
  });

  // The compiler skips wrapper lines. Remove array-style commas from complete patch lines.
  let pendingLine = "";

  for await (const chunk of chunks) {
    const lines = (pendingLine + chunk).split("\n");
    pendingLine = lines.pop() ?? "";
    for (const line of lines) yield line.trimEnd().replace(/,$/, "") + "\n";
  }

  if (pendingLine) yield pendingLine.trimEnd().replace(/,$/, "");
};
