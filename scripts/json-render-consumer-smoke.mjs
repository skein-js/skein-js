// Reuse the compatibility run's tarballs, but keep the example's SDK/dependencies separate from its
// existing 1.12.6 and legacy SDK consumers. Compile the actual application modules without aliases.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { installConsumer, root, run } from "./pack-local-consumer.mjs";

export async function verifyJsonRenderConsumer(directory, packed) {
  const example = path.join(root, "examples/json-render");
  const original = JSON.parse(await readFile(path.join(example, "package.json"), "utf8"));
  const manifest = installConsumer(
    directory,
    {
      name: "skein-json-render-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: { ...original.dependencies, "@skein-js/express": "*" },
      devDependencies: { typescript: "5.9.3", "@types/node": "22.20.0" },
    },
    packed,
  );
  await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest, null, 2));
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: directory });
  await mkdir(path.join(directory, "src"));
  for (const filename of [
    "auth.ts",
    "catalog.ts",
    "generation.ts",
    "plan-graph.ts",
    "plan-client.ts",
    "plan-session.ts",
    "ui-events.ts",
  ]) {
    await copyFile(path.join(example, "src", filename), path.join(directory, "src", filename));
  }
  await writeFile(
    path.join(directory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          rootDir: "src",
          outDir: "compiled",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], {
    cwd: directory,
  });
  await writeFile(
    path.join(directory, "langgraph.json"),
    JSON.stringify({
      graphs: { "plan-builder": "./compiled/plan-graph.js:graph" },
      auth: { path: "./compiled/auth.js:auth" },
    }),
  );
  await writeFile(
    path.join(directory, "proof.mjs"),
    String.raw`
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import {Client} from '@langchain/langgraph-sdk';
    import {createExpressServer} from '@skein-js/express';
    import {createPlanSession} from './compiled/plan-session.js';
    import {addRunIdempotency} from './compiled/plan-client.js';
    import {catalog} from './compiled/catalog.js';
    delete process.env.JSON_RENDER_MODEL;
    assert(catalog.prompt().includes('TaskList'));
    assert(catalog.jsonSchema());
    const server = await createExpressServer({config:path.resolve('langgraph.json')});
    const listener = await server.listen(0,'127.0.0.1');
    const apiUrl = 'http://127.0.0.1:'+listener.address().port;
    const client = new Client({apiUrl,apiKey:null,defaultHeaders:{'x-user':'consumer'},onRequest:addRunIdempotency});
    const session = createPlanSession(client);
    let reopened;
    try {
      let previewed = false;
      session.subscribe(()=>{previewed ||= session.read().preview;});
      await session.generate({prompt:'Plan a public workshop'});
      const saved = session.read();
      assert.equal(saved.error,null);
      assert(saved.review);
      assert(previewed);
      assert.equal(saved.spec.elements.tasks.props.tasks.length,3);
      const generation = saved.ui.generationId;
      const before = (await client.runs.list(saved.threadId)).length;
      session.dispose();
      reopened = createPlanSession(new Client({apiUrl,apiKey:null,defaultHeaders:{'x-user':'consumer'},onRequest:addRunIdempotency}));
      await reopened.open(saved.threadId);
      assert.deepEqual(reopened.read().ui,saved.ui);
      assert.equal((await client.runs.list(saved.threadId)).length,before);
      await reopened.decide(true);
      assert.equal(reopened.read().approved,true);
      assert.equal(reopened.read().ui.generationId,generation);
      await reopened.generate({prompt:'Use a smaller room'});
      assert.notEqual(reopened.read().ui.generationId,generation);
      assert.equal(reopened.read().spec.elements.summary.props.text,'Use a smaller room');
      await reopened.decide(false);
      assert.equal(reopened.read().approved,false);
      console.log('PACKED_JSON_RENDER_OK');
    } finally {session.dispose();reopened?.dispose();await server.close();}
  `,
  );
  run(process.execPath, ["proof.mjs"], { cwd: directory });
}
