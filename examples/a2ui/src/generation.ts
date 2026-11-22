import { streamGitHubUi } from "@skein-js/example-github-playground";

import { uiSurfaceIds, type SavedUi } from "./ui-contract.js";

export interface GenerationRequest {
  prompt: string;
  generationId: string;
  systemPrompt: string;
  previousUi: SavedUi | null;
}

export type GenerateText = (
  request: GenerationRequest,
  signal?: AbortSignal,
) => AsyncIterable<string>;

export const generateModelText: GenerateText = (request, signal) =>
  streamGitHubUi({
    modelSetting: "A2UI_MODEL",
    prompt: request.prompt,
    systemPrompt: request.systemPrompt,
    previousUi: request.previousUi,
    rendererContext: { surfaceIds: uiSurfaceIds(request.generationId) },
    signal,
  });
