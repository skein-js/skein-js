// A clean npm consumer outside the workspace. Every client uses its native HTTP transport.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
    import {AIMessage} from '@langchain/core/messages';
    import {MessagesAnnotation,StateGraph} from '@langchain/langgraph';
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
    const graph=new StateGraph(MessagesAnnotation).addNode('echo',state=>{executions++;return {messages:[new AIMessage('echo: '+state.messages.at(-1).content)]};}).addEdge('__start__','echo').addEdge('echo','__end__').compile();
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
      console.log('PACKED_COMPATIBILITY_OK');
    } finally {await stream?.close();await mcp.close();await server.close();}
  `,
  );
  run(process.execPath, ["proof.mjs"], { cwd: consumer, env: { ...process.env, NODE_PATH: "" } });
} finally {
  await rm(directory, { recursive: true, force: true });
}
