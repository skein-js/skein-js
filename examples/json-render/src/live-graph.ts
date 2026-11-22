import { readGitHubUiModel } from "@skein-js/example-github-playground";

import { graph as uiGraph } from "./ui-graph.js";

readGitHubUiModel("JSON_RENDER_MODEL");

export const graph = uiGraph;
