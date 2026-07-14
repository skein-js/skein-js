import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RuntimeConfigError } from "./errors.js";
import { resolveEmbed } from "./resolve-embed.js";

const configDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
// Let vitest transform the .ts fixture rather than the default native importer.
const importModule = (file: string) => import(/* @vite-ignore */ file);

describe("resolveEmbed — custom-function path", () => {
  it("adapts a raw (texts) => number[][] export", async () => {
    const embed = await resolveEmbed("./custom-embed.ts:embed", { configDir, importModule });
    expect(await embed(["a", "b"])).toEqual([
      [0, 1, 2],
      [1, 2, 3],
    ]);
  });

  it("adapts a LangChain Embeddings instance via embedDocuments", async () => {
    const embed = await resolveEmbed("./custom-embed.ts:embeddingsInstance", {
      configDir,
      importModule,
    });
    expect(await embed(["x"])).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("rejects an export that is neither a function nor an Embeddings instance", async () => {
    await expect(
      resolveEmbed("./custom-embed.ts:notAnEmbedder", { configDir, importModule }),
    ).rejects.toThrow(RuntimeConfigError);
  });

  it("rejects a missing export", async () => {
    await expect(
      resolveEmbed("./custom-embed.ts:doesNotExist", { configDir, importModule }),
    ).rejects.toThrow(/no export "doesNotExist"/);
  });
});

describe("resolveEmbed — provider:model", () => {
  it("errors clearly when the provider's package is not installed", async () => {
    // @langchain/openai is not a dependency of this package, so the dynamic import fails.
    await expect(resolveEmbed("openai:text-embedding-3-small", { configDir })).rejects.toThrow(
      /install @langchain\/openai/,
    );
  });

  it("rejects an unknown provider with the supported list", async () => {
    await expect(resolveEmbed("nope:some-model", { configDir })).rejects.toThrow(
      /Unknown embeddings provider "nope"/,
    );
  });

  it("rejects a bare string with no provider or path", async () => {
    await expect(resolveEmbed("just-a-model", { configDir })).rejects.toThrow(RuntimeConfigError);
  });
});
