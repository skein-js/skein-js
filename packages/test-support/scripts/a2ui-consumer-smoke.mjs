import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  copyTree,
  installConsumer,
  packWorkspace,
  root,
  run,
} from "../../../scripts/pack-local-consumer.mjs";

/** Compile and run the actual application outside the checkout, using public package tarballs. */
export async function verifyA2uiConsumer(directory, packed) {
  const example = path.join(root, "examples/a2ui");
  const original = JSON.parse(await readFile(path.join(example, "package.json"), "utf8"));
  const angularTools = Object.fromEntries(
    ["@angular/build", "@angular/cli", "@angular/compiler", "@angular/compiler-cli"].map((name) => [
      name,
      original.devDependencies[name],
    ]),
  );
  const manifest = installConsumer(
    directory,
    {
      name: "skein-a2ui-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: { ...original.dependencies, "@skein-js/express": "*" },
      devDependencies: { ...angularTools, typescript: "5.9.3", "@types/node": "22.20.0" },
    },
    packed,
  );
  await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest, null, 2));
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: directory });
  copyTree(path.join(example, "src"), path.join(directory, "src"));
  copyTree(path.join(example, "public"), path.join(directory, "public"));
  const backendFiles = [
    "auth.ts",
    "generation.ts",
    "ui-client.ts",
    "ui-contract.ts",
    "ui-generation.ts",
    "ui-graph.ts",
    "ui-session.ts",
    "ui-events.ts",
  ];
  await writeFile(
    path.join(directory, "tsconfig.server.json"),
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
        files: backendFiles.map((name) => "src/" + name),
      },
      null,
      2,
    ),
  );
  run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"], {
    cwd: directory,
  });
  await writeFile(
    path.join(directory, "langgraph.json"),
    JSON.stringify({
      graphs: { "ui-playground": "./compiled/ui-graph.js:graph" },
      auth: { path: "./compiled/auth.js:auth" },
    }),
  );
  await writeFile(
    path.join(directory, "proof.mjs"),
    String.raw`
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import {MessageProcessor,basicCatalog} from '@a2ui/web_core/v1_0';
    import {Client} from '@langchain/langgraph-sdk';
    import {createExpressServer} from '@skein-js/express';
    import {prepareUiRun} from './compiled/ui-client.js';
    import {createUiSession} from './compiled/ui-session.js';
    import {uiSurfaceIds} from './compiled/ui-contract.js';
    delete process.env.A2UI_MODEL;
    const renderer=new MessageProcessor([basicCatalog]);
    const metadata=()=>({
      a2uiRendererCapabilities:renderer.getRendererCapabilities({versions:['1.0'],includeInlineCatalogs:false}),
      ...(renderer.getRendererDataModel('1.0')?{a2uiRendererDataModel:renderer.getRendererDataModel('1.0')}:{}),
    });
    const server=await createExpressServer({config:path.resolve('langgraph.json')});
    const listener=await server.listen(0,'127.0.0.1');
    const client=new Client({apiUrl:'http://127.0.0.1:'+listener.address().port,apiKey:null,defaultHeaders:{'x-user':'consumer'},onRequest:prepareUiRun});
    const session=createUiSession(client,metadata);
    let reopened;
    try {
      let previewed=false;
      session.subscribe(()=>{previewed ||= session.read().preview;});
      await session.generate('A quiet coastal weekend');
      const saved=session.read();
      assert.equal(saved.error,null);
      assert(saved.review);
      assert(previewed);
      assert.equal(saved.ui.bootstrapMessages.length,3);
      await session.decide(true);
      assert.equal(session.read().approved,true);
      assert.equal(session.read().ui.generationId,saved.ui.generationId);
      renderer.processMessages(saved.ui.bootstrapMessages);
      const preferenceId=uiSurfaceIds(saved.ui.generationId).controls;
      renderer.model.getSurface(preferenceId).dataModel.set('/feedback','More gardens and less walking');
      await session.act({version:'1.0',action:{name:'reviseUi',surfaceId:preferenceId,sourceComponentId:'revise',timestamp:new Date().toISOString(),context:{prompt:'More gardens and less walking'}}});
      assert.equal(session.read().error,null);
      assert.notEqual(session.read().ui.generationId,saved.ui.generationId);
      assert(session.read().review);
      await session.decide(false);
      for(const surfaceId of renderer.getSurfaces().keys())renderer.processMessages({version:'1.0',deleteSurface:{surfaceId}});
      renderer.processMessages(session.read().ui.bootstrapMessages);
      const notesId=uiSurfaceIds(session.read().ui.generationId).notes;
      await session.act({version:'1.0',action:{name:'dismissNotes',surfaceId:notesId,sourceComponentId:'dismiss',timestamp:new Date().toISOString(),context:{}}});
      assert.equal(session.read().error,null);
      assert.equal(session.read().ui.bootstrapMessages.length,2);
      assert.equal(session.read().review,null);
      const finalUi=session.read().ui;
      const before=(await client.runs.list(saved.threadId)).length;
      reopened=createUiSession(client,metadata);
      await reopened.open(saved.threadId);
      assert.deepEqual(reopened.read().ui,finalUi);
      assert.equal(reopened.read().approved,false);
      assert.equal((await client.runs.list(saved.threadId)).length,before);
      console.log('PACKED_A2UI_RUNTIME_OK');
    } finally {session.dispose();reopened?.dispose();renderer.dispose();await server.close();}
  `,
  );
  run(process.execPath, ["proof.mjs"], { cwd: directory });

  // The adopter's Angular compiler/build also sees only declared dependencies, never repo aliases.
  await writeFile(
    path.join(directory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "preserve",
          moduleResolution: "Bundler",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          strict: true,
          noUncheckedIndexedAccess: true,
          experimentalDecorators: true,
          skipLibCheck: true,
          isolatedModules: true,
          importHelpers: true,
        },
        angularCompilerOptions: { strictTemplates: true, strictInjectionParameters: true },
      },
      null,
      2,
    ),
  );
  await copyFile(
    path.join(example, "tsconfig.app.json"),
    path.join(directory, "tsconfig.app.json"),
  );
  const angular = JSON.parse(await readFile(path.join(example, "angular.json"), "utf8"));
  angular.projects["ui-playground"].architect.build.options.outputPath = "dist";
  await writeFile(path.join(directory, "angular.json"), JSON.stringify(angular, null, 2));
  run(process.execPath, ["node_modules/@angular/cli/bin/ng.js", "build"], {
    cwd: directory,
    env: { ...process.env, NG_BUILD_MAX_WORKERS: "2" },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = await mkdtemp(path.join(tmpdir(), "skein-a2ui-consumer-"));
  try {
    await verifyA2uiConsumer(
      path.join(directory, "consumer"),
      packWorkspace(path.join(directory, "packs")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
