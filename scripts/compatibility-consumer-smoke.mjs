// A clean npm consumer outside the workspace. Every client uses its native HTTP transport.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { verifyJsonRenderConsumer } from "./json-render-consumer-smoke.mjs";
import { packWorkspace, run, installConsumer } from "./pack-local-consumer.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "skein-compatibility-consumer-"));
try {
  const packed = packWorkspace(path.join(directory, "packs"));
  const consumer = path.join(directory, "consumer");
  const manifest = installConsumer(
    consumer,
    {
      name: "skein-compatibility-proof",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: {
        "skein-js": "*",
        "@skein-js/core": "*",
        "@skein-js/agent-protocol": "*",
        typescript: "5.9.3",
        "@skein-js/local": "*",
        "@langchain/langgraph-checkpoint-sqlite": "~1.0.4",
        "@skein-js/express": "*",
        "@skein-js/server-kit": "*",
        "@langchain/langgraph": "1.4.12",
        "@langchain/core": "1.2.18",
        "@langchain/langgraph-sdk": "1.12.6",
        "sdk-legacy-25": "npm:@langchain/langgraph-sdk@1.9.25",
        "sdk-legacy-31": "npm:@langchain/langgraph-sdk@1.9.31",
        "@modelcontextprotocol/sdk": "1.32.1",
        "@a2a-js/sdk": "1.3.0",
        express: "5.2.1",
      },
    },
    packed,
  );
  await writeFile(path.join(consumer, "package.json"), JSON.stringify(manifest, null, 2));
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: consumer });
  await writeFile(
    path.join(consumer, "proof.mjs"),
    String.raw`
    import assert from 'node:assert/strict';
    import {spawn,spawnSync} from 'node:child_process';
    import {createServer} from 'node:net';
    import {createServer as createHttpServer} from 'node:http';
    import {writeFile} from 'node:fs/promises';
    import path from 'node:path';
    import {AIMessage} from '@langchain/core/messages';
    import {MessagesAnnotation,StateGraph,interrupt} from '@langchain/langgraph';
    import {createExpressServer} from '@skein-js/express';
    import {embedInMemoryGraphs} from '@skein-js/server-kit';
    import {Client} from '@langchain/langgraph-sdk';
    import {Client as Legacy25} from 'sdk-legacy-25';
    import {Client as Legacy31} from 'sdk-legacy-31';
    import {Client as McpClient} from '@modelcontextprotocol/sdk/client/index.js';
    import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
    import {ClientFactory} from '@a2a-js/sdk/client';
    import {SendMessageRequest,TaskState} from '@a2a-js/sdk';
    let executions=0;
    const graph=new StateGraph(MessagesAnnotation).addNode('echo',state=>{const content=state.messages.at(-1).content;const answer=content==='mcp-question'?interrupt('Name?'):content;executions++;return {messages:[new AIMessage('echo: '+answer)]};}).addEdge('__start__','echo').addEdge('echo','__end__').compile();
    const server=await createExpressServer({deps:embedInMemoryGraphs({agent:graph})});
    const listener=await server.listen(0,'127.0.0.1');
    const url='http://127.0.0.1:'+listener.address().port;
    const client=new Client({apiUrl:url});
    let stream;
    const mcp=new McpClient({name:'packed-proof',version:'1.0.0'});
    try {
      stream=client.threads.stream({assistantId:'agent'});
      await stream.run.start({input:{messages:[{role:'user',content:'modern'}]}});
      await stream.output;
      assert.equal(executions,1);
      const threadId=stream.threadId; await stream.close();
      stream=client.threads.stream(threadId,{assistantId:'agent'});
      await client.threads.getState(threadId); assert.equal(executions,1); await stream.close();
      const stopped=new AbortController();
      const follower=client.threads.joinStream(threadId,{streamMode:['lifecycle','state_update'],lastEventId:'0',signal:stopped.signal})[Symbol.asyncIterator]();
      try {
        const started=(await follower.next()).value;
        const done=(await follower.next()).value;
        const updated=(await follower.next()).value;
        assert.equal(started.event,'metadata');assert.equal(started.data.attempt,1);
        assert.equal(done.event,'metadata');assert.deepEqual(done.data,{status:'run_done',run_id:started.data.run_id});
        assert.equal(updated.event,'state_update');assert.equal(updated.data.thread_id,threadId);
        assert.equal(updated.data.state.values.messages.at(-1).content,'echo: modern');
        assert.equal(executions,1);
      } finally {stopped.abort();await follower.return().catch(()=>{});}
      const projected=await client.threads.search({select:['thread_id'],extract:{thread_id:'values.messages[-1].content',last:'values.messages[-1].content'}});
      const selected=projected.find(row=>row.thread_id===threadId);
      assert.deepEqual(selected.extracted,{thread_id:'echo: modern',last:'echo: modern'});
      for(const Legacy of [Legacy25,Legacy31]) {
        const old=new Legacy({apiUrl:url});const thread=await old.threads.create();
        const output=await old.runs.wait(thread.thread_id,'agent',{input:{messages:[{role:'user',content:'legacy'}]}});
        assert.equal(output.messages.at(-1).content,'echo: legacy');
      }
      await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp',url)));
      const tools=await mcp.listTools();assert(tools.tools.some(tool=>tool.name==='agent'));
      const result=await mcp.callTool({name:'agent',arguments:{messages:[{role:'user',content:'MCP'}]}});
      assert.notEqual(result.isError,true);
      const a2a=await new ClientFactory().createFromUrl(url,'/.well-known/agent-card.json?assistant_id=agent');
      const task=await a2a.sendMessage(SendMessageRequest.fromJSON({message:{messageId:'packed-a2a',role:'ROLE_USER',parts:[{text:'A2A'}]}}));
      assert.equal(task.status.state,TaskState.TASK_STATE_COMPLETED);
      const spec=await (await fetch(url+'/openapi.json')).json();assert(spec.paths['/threads/{thread_id}/stream/events']);
      assert((await (await fetch(url+'/docs')).text()).includes('Skein Agent Server API'));
      const sizes=await (await fetch(url+'/threads/'+threadId+'/storage')).json();assert(sizes.total_bytes>0);
      const searched=await fetch(url+'/runs/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:'success',thread_id:threadId,limit:1})});
      assert.equal(searched.status,200);const runs=await searched.json();
      assert.equal(runs.length,1);assert.equal(runs[0].thread_id,threadId);
      assert(!('kwargs' in runs[0]));assert(!('result' in runs[0]));
      assert(spec.paths['/runs/search'].post.requestBody.content['application/json'].schema.properties.updated_after);

      console.log('PACKED_COMPATIBILITY_OK');
    } finally {await stream?.close();await mcp.close();await server.close();}
    // Exercise the real published CLI paths: injected dependencies must retain config route flags.
    await writeFile('cli-graph.ts', "import {StateGraph,MessagesAnnotation} from '@langchain/langgraph';import {AIMessage} from '@langchain/core/messages';export const graph=new StateGraph(MessagesAnnotation).addNode('echo',(_state,config)=>({messages:[new AIMessage(JSON.stringify({tenant:config.configurable?.['x-tenant'],thread:config.configurable?.thread_id}))]})).addEdge('__start__','echo').addEdge('echo','__end__').compile();");
    await writeFile('tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:true},include:['cli-graph.ts']}));
    const callbacks=[];
    const callback=createHttpServer(async(request,response)=>{let body='';for await(const chunk of request)body+=chunk;callbacks.push({headers:request.headers,body:JSON.parse(body)});response.end('ok');});
    await new Promise(resolve=>callback.listen(0,'127.0.0.1',resolve));
    const callbackPort=callback.address().port;
    for (const command of ['dev','start']) for (const http of [{disable_docs:true},{disable_meta:true},{disable_docs:'true'},{disable_ui:true,console:true},{disable_webhooks:true},{middleware_order:'auth_first',configurable_headers:{includes:['x-*'],excludes:['x-secret']},logging_headers:{includes:['x-*']}}]) {
      await writeFile('cli-config.json',JSON.stringify({graphs:{agent:'./cli-graph.ts:graph'},http,
        ...((http.configurable_headers || http.disable_webhooks) ? {webhooks:{headers:{authorization:'Bearer $'+'{{ env.LG_WEBHOOK_BEARER }}','x-skein-signature':'forged'},url:{allowed_domains:['127.0.0.1'],allowed_ports:[callbackPort]}},skein:{webhooks:{secret:'fixture-signing-key'}}}:{}),
        ...(http.disable_ui===true?{ui:{agent:'./missing-ui.tsx'}}:{})}));
      const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
      const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
      const cli=path.resolve('node_modules/skein-js/dist/index.js');
      let config='cli-config.json';
      if(command==='start') {
        // Production startup must consume a real built artifact, including its baked graph schemas.
        const built=spawnSync(process.execPath,[cli,'build','-c',config,'--artifact-only'],{encoding:'utf8'});
        assert.equal(built.status,0,String(built.stdout)+String(built.stderr));
        config='.skein/build/langgraph.json';
      }
      const child=spawn(process.execPath,[cli,command,'-c',config,'--host','127.0.0.1','--port',String(port),...(command==='dev'?(http.disable_ui===true?[]:['--no-console']):['--store','sqlite','--queue','sqlite','--sqlite-path',path.resolve('cli-check.sqlite')])],{env:{...process.env,LG_WEBHOOK_BEARER:'private-callback-token'},stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
      const closed=new Promise(resolve=>child.once('exit',resolve));
      const base='http://127.0.0.1:'+port;
      try {
        let ready=false;
        for(let i=0;i<200;i++) {
          if(child.exitCode!==null) throw Error(output);
          try {if((await fetch(base+'/ok')).ok){ready=true;break;}}catch{}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        assert(ready,output);
        const disabled=http.disable_docs===true || http.disable_meta===true;
        assert.equal((await fetch(base+'/docs')).status,disabled?404:200,output);
        assert.equal((await fetch(base+'/openapi.json')).status,disabled?404:200);
        assert.equal((await fetch(base+'/info')).status,http.disable_meta===true?404:200);
        assert.equal((await fetch(base+'/metrics')).status,http.disable_meta===true?404:501);
        assert.equal(output.includes(base+'/docs'),!disabled);
        if(http.configurable_headers) {
          const thread=await (await fetch(base+'/threads',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
          const selected=await (await fetch(base+'/threads/'+thread.thread_id+'/runs/wait',{method:'POST',headers:{'content-type':'application/json','x-tenant':'header','x-secret':'REDACT_ME'},body:JSON.stringify({assistant_id:'agent',input:{messages:[]},config:{configurable:{'x-tenant':'body'}}})})).json();
          assert.deepEqual(JSON.parse(selected.messages.at(-1).content),{tenant:'body',thread:thread.thread_id});
          const before=callbacks.length;
          assert.equal((await fetch(base+'/runs/wait',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({assistant_id:'agent',input:{messages:[]},webhook:'http://127.0.0.1:'+callbackPort+'/outcome'})})).status,200);
          assert.equal(callbacks.length,before+1);
          assert.equal(callbacks.at(-1).headers.authorization,'Bearer private-callback-token');
          assert.match(callbacks.at(-1).headers['x-skein-signature'],/^t=/);
          assert.equal(callbacks.at(-1).body.status,'success');
        }
        if(http.disable_webhooks) {
          const before=callbacks.length;
          assert.equal((await fetch(base+'/runs/wait',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({assistant_id:'agent',webhook:'http://127.0.0.1:'+callbackPort+'/outcome'})})).status,422);
          assert.equal(callbacks.length,before);
        }
        if(http.disable_ui===true) {
          assert.equal((await fetch(base+'/ui/agent')).status,404);
          assert.equal((await fetch(base+'/console/')).status,200,'graph UI disabling must preserve Console');
        }
      } finally {
        child.kill('SIGTERM');
        const killer=setTimeout(()=>child.kill('SIGKILL'),10000);
        await closed;clearTimeout(killer);
        assert(!output.includes('REDACT_ME'),'selected credentials must be redacted from logging');
        assert(!output.includes('private-callback-token'),'webhook credentials must stay out of logging');
      }
    }
    await new Promise(resolve=>callback.close(resolve));
    console.log('PACKED_CLI_DOCS_OK');
  `,
  );
  run(process.execPath, ["proof.mjs"], { cwd: consumer, env: { ...process.env, NODE_PATH: "" } });
  await writeFile(
    path.join(consumer, "contracts.ts"),
    String.raw`
    import type { RunRepo,RunSearchQuery,SkeinStore } from '@skein-js/core';
    import type { RunService,ProtocolHandlers } from '@skein-js/agent-protocol';
    declare const store:SkeinStore;
    const query:RunSearchQuery={status:'error',assistantId:'agent',threadId:'thread',createdAfter:'2026-11-01T00:00:00.000Z',createdBefore:'2026-11-02T00:00:00.000Z',updatedAfter:'2026-11-01T00:00:00.000Z',updatedBefore:'2026-11-02T00:00:00.000Z',limit:1,offset:0,enforcedMetadata:{owner:'alice'}};
    await store.runs.search?.(query);
    declare const legacyRepository:Omit<RunRepo,'search'>;
    const repository:RunRepo=legacyRepository;
    declare const legacyService:Omit<RunService,'search'>;
    const service:RunService=legacyService;
    declare const legacyHandlers:Omit<ProtocolHandlers,'searchRuns'>;
    const handlers:ProtocolHandlers=legacyHandlers;
  `,
  );
  run(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--skipLibCheck",
      "contracts.ts",
    ],
    { cwd: consumer },
  );
  await verifyJsonRenderConsumer(path.join(directory, "json-render-consumer"), packed);
} finally {
  await rm(directory, { recursive: true, force: true });
}
