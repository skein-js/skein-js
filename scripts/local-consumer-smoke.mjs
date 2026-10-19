import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { packWorkspace, root, run, installConsumer } from "./pack-local-consumer.mjs";

const temporary = await mkdtemp(path.join(tmpdir(), "skein-packed-local-"));
const packed = packWorkspace(path.join(temporary, "packages"));
const consumer = path.join(temporary, "consumer");
try {
  const manifest = installConsumer(
    consumer,
    {
      name: "skein-local-proof",
      version: "1.0.0",
      private: true,
      type: "module",
      devDependencies: { typescript: "^5.7.2" },
      dependencies: {
        "@skein-js/local": packed["@skein-js/local"],
        "@langchain/langgraph": "^1.4.0",
        "@langchain/langgraph-checkpoint-sqlite": "~1.0.4",
      },
    },
    packed,
  );
  await writeFile(path.join(consumer, "package.json"), JSON.stringify(manifest, null, 2));
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: consumer });
  await writeFile(
    path.join(consumer, "proof.ts"),
    `import {embedSqliteGraphs, type EmbedSqliteGraphsOptions} from '@skein-js/local';
    import {openSqliteStorage, type SqliteStorageOptions} from '@skein-js/storage-sqlite';
    const options:EmbedSqliteGraphsOptions={sqlitePath:'/tmp/proof.sqlite',overrides:{clock:()=>new Date()}};
    const storageOptions:SqliteStorageOptions={filename:options.sqlitePath};
    const local=await embedSqliteGraphs({},options);await local.dispose();
    const storage=await openSqliteStorage(storageOptions);storage.database.prepare('select 1');await storage.dispose();`,
  );
  run(
    "npm",
    [
      "exec",
      "--",
      "tsc",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "proof.ts",
    ],
    { cwd: consumer },
  );
  // No workspace aliases, no NODE_PATH, only declared production dependencies from packed artifacts.
  await writeFile(
    path.join(consumer, "proof.mjs"),
    String.raw`
    import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {performance} from 'node:perf_hooks';
    import {join} from 'node:path';import {StateGraph,Annotation,interrupt} from '@langchain/langgraph';
    import {embedSqliteGraphs} from '@skein-js/local';import {createProtocolRuntime} from '@skein-js/agent-protocol';
    const require=createRequire(import.meta.url);require('@skein-js/local');require('@skein-js/storage-sqlite');
    const state=Annotation.Root({answer:Annotation({reducer:(_p,n)=>n})});
    const graph=new StateGraph(state).addNode('approve',()=>({answer:interrupt('approve?')})).addEdge('__start__','approve').addEdge('approve','__end__').compile();
    const started=performance.now();const local=await embedSqliteGraphs({proof:graph},{sqlitePath:join(process.cwd(),'state.sqlite')});
    console.log(JSON.stringify({assemblyMs:performance.now()-started,rssBytes:process.memoryUsage().rss,node:process.version,platform:process.platform,architecture:process.arch}));
    const runtime=createProtocolRuntime(local.deps);await runtime.service.assistants.registerGraphAssistants();
    const thread=await runtime.service.threads.create();await runtime.service.runs.createWait({thread_id:thread.thread_id,assistant_id:'proof',input:{answer:'waiting'}});
    assert.equal((await runtime.service.threads.get(thread.thread_id)).status,'interrupted');await local.dispose();
    const reopened=await embedSqliteGraphs({proof:graph},{sqlitePath:join(process.cwd(),'state.sqlite')});
    const next=createProtocolRuntime(reopened.deps);const resumed=await next.service.runs.createWait({thread_id:thread.thread_id,assistant_id:'proof',command:{resume:'approved'}});
    assert.deepEqual(resumed.result,{answer:'approved'});await reopened.dispose();console.log('PACKED_LOCAL_OK');
  `,
  );
  run(process.execPath, ["proof.mjs"], { cwd: consumer });
  const installed = JSON.parse(await readFile(path.join(consumer, "package-lock.json"), "utf8"));
  for (const name of Object.keys(installed.packages))
    assert(
      !/node_modules\/(?:@skein-js\/(?:config|server-kit|storage-postgres|redis)|@langchain\/langgraph-api|bullmq|pg|ioredis)(?:\/|$)/.test(
        name,
      ),
      `Unexpected local dependency: ${name}`,
    );
  for (const name of ["@skein-js/local", "@skein-js/storage-sqlite"])
    console.log(
      JSON.stringify({
        package: name,
        tarballBytes: (await stat(fileURLToPath(packed[name]))).size,
      }),
    );

  const scaffold = path.join(temporary, "scaffold");
  run(process.execPath, [
    path.join(root, "packages/create-skein-js/dist/index.js"),
    scaffold,
    "--storage",
    "sqlite",
    "--provider",
    "none",
    "--yes",
    "--no-install",
    "--no-git",
  ]);
  const generated = JSON.parse(await readFile(path.join(scaffold, "package.json"), "utf8"));
  await writeFile(
    path.join(scaffold, "package.json"),
    JSON.stringify(installConsumer(scaffold, generated, packed), null, 2),
  );
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: scaffold });
  for (const script of ["typecheck", "test", "build"])
    run("npm", ["run", script], { cwd: scaffold });
  const entry = path.join(scaffold, "node_modules/skein-js/dist/index.js");
  const filename = path.join(scaffold, ".skein/state.sqlite");
  async function serve(command, config) {
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(
      process.execPath,
      [
        entry,
        command,
        "-c",
        config,
        "--store",
        "sqlite",
        "--queue",
        "sqlite",
        "--sqlite-path",
        filename,
        "--port",
        String(port),
        ...(command === "dev" ? ["--no-request-log"] : []),
        ...(command === "dev" ? ["--no-reload", "--no-console"] : []),
      ],
      { cwd: scaffold, env: { ...process.env, NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    try {
      // The CLI banner prints the actual server address; do not race another listener for a port.
      for (let attempt = 0; attempt < 200; attempt++) {
        if (child.exitCode !== null) throw new Error(output);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/threads`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          if (response.ok) {
            console.log(`SCAFFOLD_${command.toUpperCase()}_OK`);
            return;
          }
        } catch {
          /* still starting */
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Scaffold ${command} did not start: ${output}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
  }
  await serve("dev", "langgraph.json");
  await serve("start", ".skein/build/langgraph.json");
  console.log("PACKED_SCAFFOLD_OK");
} finally {
  if (process.env["SKEIN_KEEP_CONSUMER"] === "1") console.log(`Consumer retained: ${temporary}`);
  else await rm(temporary, { recursive: true, force: true });
}
