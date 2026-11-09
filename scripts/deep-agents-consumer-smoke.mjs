// A separate installed peer graph: never upgrade the retained 1.15.1 example implicitly.
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { copyTree, installConsumer, packWorkspace, root, run } from "./pack-local-consumer.mjs";

const directory =
  process.env["SKEIN_DEEP_CONSUMER_REUSE"] ??
  (await mkdtemp(path.join(tmpdir(), "skein-deepagents-candidate-")));
let passed = false;
try {
  const consumer = path.join(directory, "consumer");
  if (!process.env["SKEIN_DEEP_CONSUMER_REUSE"]) {
    const packed = packWorkspace(path.join(directory, "packs"));
    const manifest = installConsumer(
      consumer,
      {
        name: "skein-deepagents-candidate",
        version: "1.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@skein-js/express": "*",
          "@skein-js/server-kit": "*",
          "@skein-js/agent-protocol": "*",
          "@skein-js/local": "*",
          "skein-js": "*",
          deepagents: "1.16.3",
          langchain: "1.6.2",
          "@langchain/core": "1.3.5",
          "@langchain/langgraph": "1.6.1",
          "@langchain/langgraph-sdk": "1.12.7",
          "@langchain/langgraph-checkpoint": "1.1.5",
          "@langchain/langgraph-checkpoint-sqlite": "1.0.4",
          "@langchain/openai": "1.6.3",
          "@langchain/anthropic": "1.5.13",
          "@langchain/google-genai": "2.2.0",
          "@langchain/quickjs": "0.6.6",
          langsmith: "0.9.0",
          zod: "4.3.6",
          vitest: "4.1.11",
          tsx: "4.21.0",
          "@modelcontextprotocol/client": "2.4.0",
        },
      },
      packed,
    );
    await writeFile(path.join(consumer, "package.json"), JSON.stringify(manifest, null, 2));
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: consumer });
  } else
    for (const project of ["agent-protocol", "langgraph"])
      copyTree(
        path.join(root, `packages/${project}/dist`),
        path.join(consumer, `node_modules/@skein-js/${project}/dist`),
      );
  copyTree(path.join(root, "examples/deep-agent/src"), path.join(consumer, "src"));
  // Let the consumer's TS test host own imports, as with the public Vite importer seam in dev.
  // This keeps test spies and config-loaded graphs in the same module instance.
  const serverSource = await readFile(path.join(consumer, "src/server.ts"), "utf8");
  await writeFile(
    path.join(consumer, "src/server.ts"),
    serverSource.replace(
      "{ config: configPath }",
      "{ config: configPath, importModule: (file: string) => import(/* @vite-ignore */ file) }",
    ),
  );
  copyTree(path.join(root, "scripts/fixtures/deep-agents"), path.join(consumer, "proof"));
  const config = JSON.parse(
    await readFile(path.join(root, "examples/deep-agent/langgraph.json"), "utf8"),
  );
  delete config.env;
  await writeFile(path.join(consumer, "langgraph.json"), JSON.stringify(config));
  await writeFile(
    path.join(consumer, "vitest.config.mjs"),
    "export default {test:{include:['src/**/*.test.ts','proof/**/*.test.mjs'],testTimeout:60000,hookTimeout:60000}};",
  );
  run(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      "await import('./src/briefing-assistant-graph.ts');",
    ],
    { cwd: consumer },
  );
  run(
    process.execPath,
    ["--import", "tsx", path.join(consumer, "node_modules/vitest/vitest.mjs"), "run"],
    {
      cwd: consumer,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env["NODE_OPTIONS"], "--import=tsx"].filter(Boolean).join(" "),
        LANGSMITH_TRACING: "false",
      },
    },
  );
  console.log("DEEPAGENTS_1_16_3_PACKED_CONSUMER_OK");
  passed = true;
} finally {
  // Only remove the scratch directory this invocation created; a reused checkout is caller-owned.
  if (passed && !process.env["SKEIN_DEEP_CONSUMER_REUSE"])
    await rm(directory, { recursive: true, force: true });
  else if (!passed) console.error(`Candidate consumer retained for diagnosis: ${directory}`);
}
