import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveProtocolRuntime } from "@skein-js/server-kit";

import { recordedEffects, resetRecordedDeliveries } from "./delivery-recorder.js";
import { EMAIL_SOURCE_SECRET } from "./email-source.js";
import { WHATSAPP_SOURCE_SECRET } from "./whatsapp-source.js";

const exampleRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(exampleRoot, "langgraph.json");
const uiRoot = path.join(exampleRoot, "ui");
const maxRequestBytes = 64 * 1024;

const staticFiles = new Map([
  ["/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
]);

function providerRequest(channel: "email" | "whatsapp", secret: string, body: unknown) {
  return {
    method: "POST",
    url: `http://127.0.0.1:2024/channels/${channel}`,
    headers: { "content-type": "application/json", "x-example-token": secret },
    body: JSON.stringify(body),
    params: {},
    query: {},
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let requestBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    requestBytes += buffer.byteLength;
    if (requestBytes > maxRequestBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function inboundResponseBody(result: { kind: string; status: number; body?: unknown }): unknown {
  return result.kind === "json" ? result.body : { accepted: result.status === 202 };
}

export interface DemoUiHandle {
  url: string;
  stop(): Promise<void>;
}

/** Start a local-only UI around the same resolved channel handlers used by the CLI demo. */
export async function startDemoUi(options: { port?: number } = {}): Promise<DemoUiHandle> {
  resetRecordedDeliveries();
  const resolved = await resolveProtocolRuntime({ config: configPath });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const staticFile = staticFiles.get(url.pathname);
      if (request.method === "GET" && staticFile) {
        response.writeHead(200, {
          "content-security-policy":
            "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          "content-type": staticFile.contentType,
          "x-content-type-options": "nosniff",
        });
        response.end(await readFile(path.join(uiRoot, staticFile.file)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reset") {
        resetRecordedDeliveries();
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/email") {
        const result = await resolved.runtime.handlers.handleInboundEvent(
          providerRequest("email", EMAIL_SOURCE_SECRET, await readJson(request)),
        );
        sendJson(response, result.status, inboundResponseBody(result));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/whatsapp") {
        const result = await resolved.runtime.handlers.handleInboundEvent(
          providerRequest("whatsapp", WHATSAPP_SOURCE_SECRET, await readJson(request)),
        );
        sendJson(response, result.status, inboundResponseBody(result));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          sendJson(response, 400, { error: "conversationId is required" });
          return;
        }
        try {
          const thread = await resolved.runtime.service.threads.get(`relay:${conversationId}`);
          sendJson(response, 200, {
            thread: {
              status: thread.status,
              values: thread.values,
              interrupts: Object.values(thread.interrupts ?? {}).flat(),
            },
            deliveries: recordedEffects(),
          });
        } catch {
          sendJson(response, 200, { thread: null, deliveries: recordedEffects() });
        }
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      sendJson(response, 400, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3030, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`Decoupled delivery UI: ${url}`);

  return {
    url,
    async stop() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await resolved.runtime.worker.stop();
    },
  };
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const demoUi = await startDemoUi();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void demoUi.stop().then(() => process.exit(0)));
  }
}
