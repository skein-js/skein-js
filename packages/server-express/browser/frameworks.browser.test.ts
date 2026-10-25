import { createServer, request as proxyRequest, type Server } from "node:http";
import { AIMessage } from "@langchain/core/messages";
import {
  MessagesAnnotation,
  StateGraph,
  StreamChannel,
  type StreamTransformer,
} from "@langchain/langgraph";
import { langGraphResolver } from "@skein-js/langgraph";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium, type Browser } from "@playwright/test";
import { build } from "esbuild";
import { compile, compileModule } from "svelte/compiler";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  createEchoDeps,
  createEchoResolver,
  startEchoServer,
  type RunningServer,
} from "../src/__fixtures__/echo-server.js";

interface BrowserStream {
  submit(input: unknown): Promise<void>;
  respond(response: unknown): Promise<void>;
  stop(): Promise<void>;
}
interface BrowserSnapshot {
  text?: string;
  threadId: string | null;
  loading: boolean;
  interrupt?: { value: unknown };
  custom?: unknown[];
  images: number;
  connectionKinds: string[];
  reconnections: number;
  reconnectAttempts: number;
  error: string;
}
declare global {
  interface Window {
    stream: BrowserStream;
    read(): BrowserSnapshot;
    readMedia(): Promise<{ mime: string; bytes: number[] }>;
  }
}
function createProgressTransformer(): StreamTransformer {
  const progress = StreamChannel.remote("progress");
  return {
    init: () => ({ progress }),
    process: (event) => {
      if (event.method === "values") progress.push({ phase: "saved" });
      return true;
    },
  };
}

let browser: Browser;
let server: RunningServer;
let proxy: Server;
let browserUrl: string;
let slowExecutions = 0;
let threadBus: NonNullable<ReturnType<typeof createEchoDeps>["threadBus"]>;

const expose = `window.read = () => {const s=window.stream; const get=x=>typeof x==='function'?x():x&&x.__v_isRef?x.value:x&&typeof x==='object'&&'current' in x?x.current:x; const values=get(s.values);const content=values.messages?.at(-1)?.content;return {custom:get(window.custom),images:get(window.images)?.length||0,connectionKinds:window.connectionKinds||[],reconnectAttempts:window.reconnectAttempts||0,reconnections:window.reconnections||0,values,text:typeof content==='string'?content:content?.map(x=>x.text||'').join(''),loading:get(s.isLoading),threadId:get(s.threadId),interrupt:get(s.interrupt),error:String(get(s.error)||'')};};`;
const mediaProbe = `window.readMedia=async()=>{let value=window.images;value=typeof value==='function'?value():value&&value.__v_isRef?value.value:value&&'current' in value?value.current:value;const blob=await value[0].blob;return {mime:blob.type,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};};`;
const options = `({apiUrl:location.origin, assistantId: new URLSearchParams(location.search).get('assistant')||'echo', threadId:new URLSearchParams(location.search).get('thread'), optimistic:false, onReconnect:()=>{window.reconnectAttempts=(window.reconnectAttempts||0)+1;},onConnected:({kind})=>{(window.connectionKinds||=[]).push(kind);if(kind==='reconnected')window.reconnections=(window.reconnections||0)+1;}, reconnectDelayMs:()=>10})`;

const entries: Record<string, string> = {
  react: `import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import {useStream,useChannel,useImages} from '@langchain/react'; function App(){window.stream=useStream(${options}); window.custom=useChannel(window.stream,['custom:progress']); window.images=useImages(window.stream,['asset']); return createElement('p',null,'React');} createRoot(document.getElementById('app')).render(createElement(App)); ${expose} ${mediaProbe}`,
  vue: `import {createApp,h,toRaw} from 'vue'; import {useStream,useChannel,useImages} from '@langchain/vue'; createApp({setup(){window.stream=useStream(${options}); window.custom=useChannel(window.stream,['custom:progress']); window.images=useImages(window.stream,['asset']); return ()=>h('p','Vue');}}).mount('#app'); ${expose} ${mediaProbe.replace("value[0].blob", "toRaw(value[0]).blob")}`,
  angular: `import '@angular/compiler'; import {createApplication} from '@angular/platform-browser'; import {runInInjectionContext,provideZonelessChangeDetection} from '@angular/core'; import {injectStream,injectChannel,injectImages} from '@langchain/angular'; const app=await createApplication({providers:[provideZonelessChangeDetection()]}); window.stream=runInInjectionContext(app.injector,()=>{const stream=injectStream(${options});window.custom=injectChannel(stream,['custom:progress']);window.images=injectImages(stream,['asset']);return stream;}); ${expose} ${mediaProbe}`,
  svelte: `import {mount} from 'svelte'; import App from './Harness.svelte'; mount(App,{target:document.getElementById('app')}); ${expose} ${mediaProbe}`,
};

// Exercise the current React SDK installed by the frontend example alongside the pinned matrix.
entries["react-current"] = entries["react"]!;

beforeAll(async () => {
  const bundles = new Map<string, string>();
  for (const [name, entry] of Object.entries(entries)) {
    const bundled = await build({
      stdin: {
        contents: entry,
        resolveDir:
          name === "react-current" ? resolve("../../examples/react-usestream") : resolve("."),
        sourcefile: `${name}-harness.js`,
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      conditions: ["browser"],
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "svelte",
          setup(builder) {
            builder.onResolve({ filter: /Harness\.svelte$/ }, () => ({
              path: "Harness.svelte",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: compile(
                `<script>import {useStream,useChannel,useImages} from '@langchain/svelte'; window.stream=useStream(${options}); window.custom=useChannel(window.stream,['custom:progress']);window.images=useImages(window.stream,['asset']);</script><p>Svelte</p>`,
                { filename: "Harness.svelte", generate: "client" },
              ).js.code,
              resolveDir: resolve("."),
            }));
            builder.onLoad({ filter: /\.svelte\.js$/ }, async (args) => ({
              contents: compileModule(await readFile(args.path, "utf8"), {
                filename: args.path,
                generate: "client",
              }).js.code,
              resolveDir: resolve(args.path, ".."),
            }));
          },
        },
      ],
    });
    bundles.set(name, bundled.outputFiles[0]!.text);
  }
  // Bundle the actual example pages, resolving SDK imports from each example's dependencies.
  for (const name of ["react-usestream", "nextjs-app", "chat-app"]) {
    const exampleRoot = resolve("../../examples", name);
    const bundled = await build({
      stdin: {
        contents: `import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import Page from './app/page'; createRoot(document.getElementById('app')).render(createElement(Page));`,
        resolveDir: exampleRoot,
      },
      tsconfig: resolve(exampleRoot, "tsconfig.json"),
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.NEXT_PUBLIC_SKEIN_URL": "location.origin",
        "process.env.NEXT_PUBLIC_SKEIN_ASSISTANT_ID": '"echo"',
        "process.env.NEXT_PUBLIC_SKEIN_API_KEY": "undefined",
      },
    });
    bundles.set(`example-${name}`, bundled.outputFiles[0]!.text);
  }
  const deps = createEchoDeps();
  threadBus = deps.threadBus!;
  const slow = new StateGraph(MessagesAnnotation)
    .addNode("wait", async (_state, config) => {
      slowExecutions++;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        config.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
      return { messages: [new AIMessage("finished")] };
    })
    .addEdge("__start__", "wait")
    .addEdge("wait", "__end__")
    .compile();
  const leaf = new StateGraph(MessagesAnnotation)
    .addNode("leaf", () => ({ messages: [new AIMessage("nested reply")] }))
    .addEdge("__start__", "leaf")
    .addEdge("leaf", "__end__")
    .compile();
  const nested = new StateGraph(MessagesAnnotation)
    .addNode("child", leaf)
    .addEdge("__start__", "child")
    .addEdge("child", "__end__")
    .compile();
  const media = new StateGraph(MessagesAnnotation)
    .addNode("image", () => ({
      messages: [
        new AIMessage({
          id: "image-message",
          content: [{ type: "image", source_type: "base64", mime_type: "image/png", data: "AQID" }],
        }),
      ],
    }))
    .addEdge("__start__", "image")
    .addEdge("image", "__end__")
    .compile()
    .withConfig<readonly [typeof createProgressTransformer]>({
      streamTransformers: [createProgressTransformer],
    });
  const mediaGraph = new StateGraph(MessagesAnnotation)
    .addNode("asset", media)
    .addEdge("__start__", "asset")
    .addEdge("asset", "__end__")
    .compile()
    .withConfig<readonly [typeof createProgressTransformer]>({
      streamTransformers: [createProgressTransformer],
    });
  const base = createEchoResolver();
  const extras = { slow, nested, media: mediaGraph, agent: await base.load("echo") };
  deps.graphs = langGraphResolver({
    ids: [...base.ids, ...Object.keys(extras)],
    load: async (id) =>
      id in extras ? (extras[id as keyof typeof extras] as never) : base.load(id),
    schemas: base.schemas,
  });
  deps.httpHandler = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/harness")
      return new Response(
        '<!doctype html><div id="app"></div><script type="module" src="/harness.js?framework=' +
          new URL(request.url).searchParams.get("framework") +
          '"></script>',
        { headers: { "content-type": "text/html" } },
      );
    if (path === "/harness.js")
      return new Response(bundles.get(new URL(request.url).searchParams.get("framework")!), {
        headers: { "content-type": "text/javascript" },
      });
    return undefined;
  };
  server = await startEchoServer({ deps });
  proxy = createServer((incoming, outgoing) => {
    const upstream = proxyRequest(
      new URL((incoming.url ?? "/").replace(/^\/api\//, "/"), server.baseUrl),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 500, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  browserUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  proxy?.closeAllConnections();
  if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await server?.close();
});

it.each(["react-usestream", "nextjs-app", "chat-app"])(
  "%s example renders multiple turns with its installed current React SDK",
  async (example) => {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    try {
      await page.goto(`${browserUrl}/harness?framework=example-${example}`);
      const input = page.locator("input, textarea");
      for (const message of ["first", "second"]) {
        await input.fill(message);
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect
          .poll(() => page.getByText(`echo: ${message}`, { exact: true }).count())
          .toBe(1);
      }
      if (example === "chat-app") {
        await page.getByRole("button", { name: "New chat", exact: true }).click();
        await expect.poll(() => page.getByTestId("assistant-message").count()).toBe(0);
        await page.getByTitle("first", { exact: true }).click();
        await expect.poll(() => page.getByText("echo: second", { exact: true }).count()).toBe(1);
      }
      expect(failures).toEqual([]);
    } finally {
      await page.close();
    }
  },
);

it.each(Object.keys(entries))(
  "%s streams multiple turns, restores state and resumes an interrupt over native HTTP",
  async (framework) => {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    try {
      await page.goto(`${browserUrl}/harness?framework=${framework}`);
      await page.waitForFunction(() => Boolean(window.stream));
      await page.evaluate(() =>
        window.stream.submit({ messages: [{ role: "user", content: "first" }] }),
      );
      await expect.poll(async () => page.evaluate(() => window.read().text)).toBe("echo: first");
      await page.evaluate(() =>
        window.stream.submit({ messages: [{ role: "user", content: "second" }] }),
      );
      await expect.poll(async () => page.evaluate(() => window.read().text)).toBe("echo: second");
      const threadId = await page.evaluate(() => window.read().threadId);
      if (!threadId) throw new Error("The SDK did not bind a thread.");
      expect(await server.server.runtime.service.runs.listByThread(threadId)).toHaveLength(2);
      await page.goto(`${browserUrl}/harness?framework=${framework}&thread=${threadId}`);
      await expect.poll(async () => page.evaluate(() => window.read?.().text)).toBe("echo: second");
      expect(await server.server.runtime.service.runs.listByThread(threadId)).toHaveLength(2);
      await page.goto(`${browserUrl}/harness?framework=${framework}&assistant=hitl`);
      await page.waitForFunction(() => Boolean(window.stream));
      await page.evaluate(() =>
        window.stream.submit({ messages: [{ role: "user", content: "approval" }] }),
      );
      await expect
        .poll(async () => page.evaluate(() => window.read().interrupt?.value))
        .toBe("approve?");
      await page.evaluate(() => window.stream.respond("yes"));
      await expect.poll(async () => page.evaluate(() => window.read().text)).toBe("approved: yes");
      await page.goto(`${browserUrl}/harness?framework=${framework}&assistant=nested`);
      await page.waitForFunction(() => Boolean(window.stream));
      await page.evaluate(() =>
        window.stream.submit({ messages: [{ role: "user", content: "nested" }] }),
      );
      await expect.poll(async () => page.evaluate(() => window.read().text)).toBe("nested reply");
      await page.goto(`${browserUrl}/harness?framework=${framework}&assistant=media`);
      await page.waitForFunction(() => Boolean(window.stream));
      await page.waitForTimeout(100);
      await page.evaluate(() =>
        window.stream.submit({ messages: [{ role: "user", content: "media" }] }),
      );
      const mediaThread = await page.evaluate(() => window.read().threadId);
      if (!mediaThread) throw new Error("The SDK did not bind a media thread.");
      const tip = await threadBus.latestSequence(mediaThread);
      const captured = [];
      for await (const event of threadBus.subscribe(mediaThread, 0)) {
        if (event.kind === "protocol")
          captured.push([
            event.event.method,
            event.event.params.namespace,
            event.event.method === "messages" ? event.event.params.data : null,
          ]);
        if (event.seq >= tip) break;
      }
      expect(
        captured.some(([method]) => method === "custom"),
        JSON.stringify(captured),
      ).toBe(true);
      await expect
        .poll(async () => page.evaluate(() => window.read().custom?.length), {
          message: JSON.stringify(captured),
        })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => page.evaluate(() => window.read().images), {
          message: JSON.stringify(captured),
        })
        .toBe(1);
      expect(await page.evaluate(() => window.readMedia())).toEqual({
        mime: "image/png",
        bytes: [1, 2, 3],
      });
      await page.goto(`${browserUrl}/harness?framework=${framework}&assistant=slow`);
      await page.waitForFunction(() => Boolean(window.stream));
      const executionsBefore = slowExecutions;
      await page.evaluate(() => {
        void window.stream
          .submit({ messages: [{ role: "user", content: "cancel" }] })
          .catch(() => {});
      });
      await expect.poll(async () => page.evaluate(() => window.read().loading)).toBe(true);
      await expect.poll(() => slowExecutions).toBe(executionsBefore + 1);
      await page.waitForFunction(() => window.read().connectionKinds.length > 0);
      await page.waitForTimeout(100);
      proxy.closeAllConnections();
      await expect
        .poll(async () => page.evaluate(() => window.read().reconnections), { timeout: 10_000 })
        .toBeGreaterThan(0);
      await page.evaluate(() => window.stream.stop());
      const cancelledThread = await page.evaluate(() => window.read().threadId);
      if (!cancelledThread) throw new Error("The SDK did not bind a cancellable thread.");
      await expect
        .poll(
          async () =>
            (await server.server.runtime.service.runs.listByThread(cancelledThread))[0]?.status,
        )
        .toBe("cancelled");
      expect(slowExecutions).toBe(executionsBefore + 1);
      expect(failures).toEqual([]);
    } finally {
      await page.close();
    }
  },
);
