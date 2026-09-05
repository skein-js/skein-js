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
    devStorage: "memory",
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

    // The two come from one template but must not be byte-identical: they were, so the file that
    // *is* `.env` opened by telling you to copy it to `.env`.
    const dotEnv = files.find((file) => file.path === ".env")!.contents;
    const example = files.find((file) => file.path === ".env.example")!.contents;
    expect(dotEnv).not.toBe(example);
    // The instruction itself, not the word "copy". `.env` must not tell you to produce `.env` — it
    // is `.env`. `.env.example` must, because it is the only one of the two a fresh clone gets.
    expect(dotEnv).not.toMatch(/copy this file to `?\.env/i);
    expect(example).toMatch(/copy this file to `?\.env/i);
    // Only the header differs. Compared from the first divider rather than by line count, because
    // the two headers are deliberately different lengths — everything a reader would actually set
    // has to stay identical, or the "reference copy" stops being one.
    const body = (contents: string): string => {
      const divider = contents.indexOf("# ---");
      // Guarded: `slice(-1)` would compare one character and pass whatever the two files held.
      expect(divider, "no `# ---` divider to compare bodies from").toBeGreaterThan(-1);
      return contents.slice(divider);
    };
    expect(body(dotEnv)).toBe(body(example));
    expect(body(dotEnv)).toContain("POSTGRES_URI=");

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

  it("declares every package the generated source imports", () => {
    // The general form of a bug that shipped: the `createReactAgent` -> `createAgent` migration
    // rewrote the agent template to `import { createAgent } from "langchain"` and added the version
    // to the shared table, but never added `langchain` to the generated manifest. Every scaffolded
    // project with a provider then failed `tsc --noEmit` on its very first typecheck — caught only by
    // the smoke test in CI, and only after install.
    //
    // Asserted over the source rather than against a fixed list, so the next template that reaches
    // for a new package fails here instead of in someone's fresh project.
    for (const provider of ["anthropic", "openai", "google", "none"] as const) {
      const files = buildProjectFiles(optionsFor(provider));
      const manifest = JSON.parse(files.find((file) => file.path === "package.json")!.contents) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ]);

      for (const file of files.filter((candidate) => candidate.path.endsWith(".ts"))) {
        for (const match of file.contents.matchAll(/from "([^"]+)"/g)) {
          const specifier = match[1]!;
          // Relative imports are the project's own; `node:` is the platform's.
          if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
          // A subpath import (`@langchain/langgraph/prebuilt`) is satisfied by its package.
          const packageName = specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0]!;
          expect(
            declared,
            `${file.path} imports "${specifier}" but ${packageName} is not in package.json (provider: ${provider})`,
          ).toContain(packageName);
        }
      }
    }
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
    // Durable development, which the CLI always supported and no script exposed.
    expect(manifest.scripts["dev:postgres"]).toContain("--store postgres");
    expect(manifest.scripts["dev:postgres"]).toContain("--queue redis");
    // In-memory by default, so `dev` needs nothing installed or started.
    expect(manifest.scripts["dev"]).not.toContain("--store postgres");

    // `start` serves the *artifact*, so it must point at the artifact's own `langgraph.json`. A bare
    // `skein start` resolves `langgraph.json` from the cwd and dies on the missing `schemas.json`
    // beside it — which made the generated README's own "Ship it" steps fail at the last one.
    expect(manifest.scripts["start"]).toBe("skein start -c .skein/build/langgraph.json");
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

    // Uncommented, not merely present: they used to be commented out, so the documented `start`
    // step failed and the README told you to hand-edit a file in the middle of the happy path. The
    // values match the compose file above, so there was never anything for the user to decide.
    const envExample = files.find((file) => file.path === ".env.example")!;
    expect(envExample.contents).toMatch(
      /^POSTGRES_URI=postgresql:\/\/postgres:postgres@localhost:5432\/skein$/m,
    );
    expect(envExample.contents).toMatch(/^REDIS_URI=redis:\/\/localhost:6379$/m);
    const dotEnv = files.find((file) => file.path === ".env")!;
    expect(dotEnv.contents).toMatch(/^POSTGRES_URI=/m);
    expect(dotEnv.contents).toMatch(/^REDIS_URI=/m);
  });

  it("pins skein-js to the range it was told to", () => {
    const manifest = JSON.parse(
      buildProjectFiles(optionsFor("none")).find((file) => file.path === "package.json")!.contents,
    ) as { devDependencies: Record<string, string> };

    expect(manifest.devDependencies["skein-js"]).toBe("^0.14.0");
  });
});

describe("the local development storage axis", () => {
  const scriptsFor = (devStorage: ScaffoldOptions["devStorage"]) =>
    JSON.parse(
      buildProjectFiles({ ...optionsFor("none"), devStorage }).find(
        (file) => file.path === "package.json",
      )!.contents,
    ).scripts as Record<string, string>;

  it("makes `dev` durable when asked, and keeps the in-memory spelling", () => {
    const scripts = scriptsFor("postgres");

    expect(scripts["dev"]).toContain("--store postgres --queue redis");
    expect(scripts["dev:memory"]).toBe("skein dev --port 2024");
    expect(scripts["dev:postgres"]).toBeUndefined();
  });

  it("never takes the other spelling away", () => {
    // Choosing at scaffold time picks a default, not a capability: whichever way the axis goes, both
    // commands are on disk, so nobody has to discover a pair of flags the project never mentions.
    for (const storage of ["memory", "postgres"] as const) {
      const scripts = scriptsFor(storage);
      const both = [scripts["dev"], scripts["dev:memory"] ?? scripts["dev:postgres"]];
      expect(both.filter((script) => script?.includes("--store postgres"))).toHaveLength(1);
      expect(both.filter((script) => script === "skein dev --port 2024")).toHaveLength(1);
    }
  });
});
