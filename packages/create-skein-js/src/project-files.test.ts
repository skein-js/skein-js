// Invariants that must hold for every project this scaffolder can emit.
//
// The matrix is small enough to run exhaustively, so these are not samples — they are proofs over
// the whole space. Three of them are load-bearing:
//
//   - the zero-setup guarantee: whatever you pick, `skein dev` boots without a credential
//   - every emitted .ts parses: the one real hazard of generating code is a mis-escaped literal
//   - every emitted file is Prettier-clean: a starter should look hand-written, and asserting it
//     here is why the generators do not need devkit's formatFiles

import { format, resolveConfig } from "prettier";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import { PROVIDER_DETAILS } from "./dependency-versions.js";
import { buildProjectFiles } from "./project-files.js";
import { MODEL_PROVIDERS, type GeneratedFile, type ScaffoldOptions } from "./scaffold-options.js";

function optionsFor(provider: ScaffoldOptions["provider"]): ScaffoldOptions {
  return {
    projectName: "my-agent",
    packageName: "my-agent",
    provider,
    packageManager: "pnpm",
    skeinVersionRange: "^0.14.0",
  };
}

const everyProvider = MODEL_PROVIDERS.map((provider) => [provider, optionsFor(provider)] as const);

describe.each(everyProvider)("a project scaffolded with --provider %s", (provider, options) => {
  let files: readonly GeneratedFile[];

  beforeAll(() => {
    files = buildProjectFiles(options);
  });

  // langgraph.json's `env` field points at `.env`; without the file, the first `skein dev` opens
  // with a warning about a missing file even though nothing is wrong.
  it("writes the .env that langgraph.json points at", () => {
    const config = JSON.parse(files.find((file) => file.path === "langgraph.json")!.contents) as {
      env: string;
    };
    const emitted = new Set(files.map((file) => file.path));

    expect(emitted.has(config.env)).toBe(true);
    expect(files.find((file) => file.path === ".env")!.contents).toBe(
      files.find((file) => file.path === ".env.example")!.contents,
    );

    // …and it must stay out of git, since a real one will hold real keys.
    expect(files.find((file) => file.path === ".gitignore")!.contents).toMatch(/^\.env$/m);
  });

  it("emits the files every skein project needs", () => {
    const paths = files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "package.json",
        "tsconfig.json",
        "langgraph.json",
        ".gitignore",
        ".env.example",
        "README.md",
        "compose.dev.yaml",
        "src/echo-graph.ts",
      ]),
    );
  });

  it("emits paths that are unique, relative and inside the project", () => {
    const paths = files.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const filePath of paths) {
      expect(filePath.startsWith("/"), `${filePath} is absolute`).toBe(false);
      expect(filePath.split("/").includes(".."), `${filePath} escapes the root`).toBe(false);
      expect(filePath.includes("\\"), `${filePath} is not POSIX`).toBe(false);
    }
  });

  it("is deterministic", () => {
    expect(buildProjectFiles(options)).toEqual(files);
  });

  it("emits no unresolved template placeholders", () => {
    for (const file of files) {
      expect(file.contents, `${file.path} has an unrendered placeholder`).not.toMatch(/\{\{/);
    }
  });

  it("emits valid JSON in every .json file", () => {
    for (const file of files.filter((candidate) => candidate.path.endsWith(".json"))) {
      expect(() => JSON.parse(file.contents), `${file.path} is not valid JSON`).not.toThrow();
    }
  });

  it("points langgraph.json at graphs it actually emits", () => {
    const config = JSON.parse(files.find((file) => file.path === "langgraph.json")!.contents) as {
      graphs: Record<string, string>;
    };
    const emitted = new Set(files.map((file) => file.path));

    for (const spec of Object.values(config.graphs)) {
      const [graphPath] = spec.split(":");
      expect(emitted.has(graphPath!.replace(/^\.\//, "")), `${spec} names a missing file`).toBe(
        true,
      );
    }
  });

  it("lists echo first, so the first request works with no credentials", () => {
    const config = JSON.parse(files.find((file) => file.path === "langgraph.json")!.contents) as {
      graphs: Record<string, string>;
    };
    expect(Object.keys(config.graphs)[0]).toBe("echo");
  });

  // The guarantee the whole scaffolder rests on. The agent graph may read a key; nothing on the
  // path `skein dev` takes to serve `echo` may.
  it("runs with no API key", () => {
    const alwaysLoaded = files.filter(
      (file) => file.path.endsWith(".ts") && file.path !== "src/agent-graph.ts",
    );
    for (const file of alwaysLoaded) {
      expect(file.contents, `${file.path} reads the environment`).not.toMatch(/process\.env/);
    }

    if (provider === "none") {
      const keyNames = Object.values(PROVIDER_DETAILS).map((details) => details.apiKeyEnvVar);
      for (const file of files) {
        for (const keyName of keyNames) {
          expect(file.contents, `${file.path} mentions ${keyName}`).not.toContain(keyName);
        }
      }
    }
  });

  // The agent graph builds its model at import time, so an unset key fails the whole module. That is
  // fine — but it has to fail saying which variable, in a sentence, rather than leaving the user to
  // read the model client's own error out of a wrapped stack trace.
  it("names the missing key itself rather than letting the model client do it", () => {
    if (provider === "none") return;
    const { apiKeyEnvVar, consoleUrl } = PROVIDER_DETAILS[provider];
    const agentGraph = files.find((file) => file.path === "src/agent-graph.ts")!.contents;

    // Guarded before the model is constructed, not after.
    expect(agentGraph.indexOf("throw new Error")).toBeLessThan(agentGraph.indexOf("new Chat"));
    expect(agentGraph).toContain(`process.env.${apiKeyEnvVar}`);
    expect(agentGraph).toContain(`${apiKeyEnvVar} is not set`);
    // …and says where to get one, so the message is a fix and not just a diagnosis.
    expect(agentGraph).toContain(consoleUrl);
  });

  it("emits TypeScript that parses", () => {
    for (const file of files.filter((candidate) => candidate.path.endsWith(".ts"))) {
      const source = ts.createSourceFile(
        file.path,
        file.contents,
        ts.ScriptTarget.ES2022,
        /* setParentNodes */ false,
        ts.ScriptKind.TS,
      );
      // `parseDiagnostics` is internal but is the only way to see syntax errors without a Program,
      // and a Program would need the generated project's dependencies installed.
      const diagnostics = (source as unknown as { parseDiagnostics: readonly ts.Diagnostic[] })
        .parseDiagnostics;
      expect(
        diagnostics.map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        ),
        `${file.path} has syntax errors`,
      ).toEqual([]);
    }
  });

  it("emits files Prettier would not reformat", async () => {
    const parsers: Record<string, string> = {
      ".ts": "typescript",
      ".json": "json",
      ".md": "markdown",
      ".yaml": "yaml",
    };
    const prettierConfig = await resolveConfig("project.ts");

    for (const file of files) {
      const extension = file.path.slice(file.path.lastIndexOf("."));
      const parser = parsers[extension];
      if (parser === undefined) continue;
      const formatted = await format(file.contents, { ...prettierConfig, parser });
      expect(formatted, `${file.path} is not Prettier-clean`).toBe(file.contents);
    }
  });
});

describe("provider selection", () => {
  it("emits an agent graph only when a provider was chosen", () => {
    const withoutProvider = buildProjectFiles(optionsFor("none")).map((file) => file.path);
    expect(withoutProvider).not.toContain("src/agent-graph.ts");

    const withProvider = buildProjectFiles(optionsFor("google")).map((file) => file.path);
    expect(withProvider).toContain("src/agent-graph.ts");
  });

  it.each(["google", "anthropic", "openai"] as const)("wires %s's model class", (provider) => {
    const agentGraph = buildProjectFiles(optionsFor(provider)).find(
      (file) => file.path === "src/agent-graph.ts",
    )!;
    const details = PROVIDER_DETAILS[provider];

    expect(agentGraph.contents).toContain(`import { ${details.modelClass} }`);
    expect(agentGraph.contents).toContain(details.packageName);
    expect(agentGraph.contents).toContain(`new ${details.modelClass}(`);
    expect(agentGraph.contents).toContain(details.defaultModel);
  });

  it("pins the model package the graph imports", () => {
    const manifest = JSON.parse(
      buildProjectFiles(optionsFor("anthropic")).find((file) => file.path === "package.json")!
        .contents,
    ) as { dependencies: Record<string, string> };

    expect(manifest.dependencies["@langchain/anthropic"]).toBe(
      PROVIDER_DETAILS.anthropic.versionRange,
    );
  });
});

describe("the scripts a scaffolded project ships", () => {
  it("covers the whole skein CLI lifecycle", () => {
    const manifest = JSON.parse(
      buildProjectFiles(optionsFor("none")).find((file) => file.path === "package.json")!.contents,
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts["dev"]).toContain("skein dev");
    expect(manifest.scripts["build"]).toContain("skein build");
    expect(manifest.scripts["start"]).toBe("skein start");
  });

  // `skein start` defaults to --store postgres --queue redis and fails without them, so a project
  // that ships a `start` script must also ship the services it needs. Otherwise the script is a trap.
  it("ships the Postgres and Redis that `skein start` requires", () => {
    const files = buildProjectFiles(optionsFor("none"));
    const compose = files.find((file) => file.path === "compose.dev.yaml")!;

    expect(compose.contents).toContain("pgvector/pgvector");
    expect(compose.contents).toContain("redis");

    // …bound to loopback, never 0.0.0.0. A bare "5432:5432" publishes a superuser-credentialed
    // Postgres onto whatever network the developer is attached to, and this file ships to every
    // scaffolded project — one careless edit would expose every machine that ever ran the scaffolder.
    expect(compose.contents, "a port is published on all interfaces").not.toMatch(
      /^\s*-\s*"\d+:\d+"/m,
    );
    expect(compose.contents).toContain('"127.0.0.1:5432:5432"');
    expect(compose.contents).toContain('"127.0.0.1:6379:6379"');

    const envExample = files.find((file) => file.path === ".env.example")!;
    expect(envExample.contents).toContain("POSTGRES_URI");
    expect(envExample.contents).toContain("REDIS_URI");
  });

  it("pins skein-js to the range it was told to", () => {
    const manifest = JSON.parse(
      buildProjectFiles(optionsFor("none")).find((file) => file.path === "package.json")!.contents,
    ) as { devDependencies: Record<string, string> };

    expect(manifest.devDependencies["skein-js"]).toBe("^0.14.0");
  });
});
