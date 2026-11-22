import { readGitHubUiModel } from "@skein-js/example-github-playground";

import { graph as uiGraph } from "./ui-graph.js";

readGitHubUiModel("A2UI_MODEL");

export const graph = uiGraph;
