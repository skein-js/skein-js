// skein-js embedded in an existing Fastify app: the app keeps its own REST routes AND serves the
// Agent Protocol, mounted under `/agent` via `skeinPlugin`. The plugin is encapsulated, so skein's
// routes (and any CORS) stay isolated from the rest of the app. Run with `tsx src/app.ts`, or import
// `startServer` / `buildApp` in a test.

import { fileURLToPath, pathToFileURL } from "node:url";

import { skeinPlugin } from "@skein-js/fastify";
import Fastify, { type FastifyInstance } from "fastify";

const configPath = fileURLToPath(new URL("../langgraph.json", import.meta.url));

// The app's own in-memory "todos" — a stand-in for whatever REST your product already serves.
interface Todo {
  id: number;
  title: string;
}
const todos: Todo[] = [{ id: 1, title: "Try skein-js" }];

/** Build a Fastify app with its own routes plus the Agent Protocol under `/agent`. */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();

  // The app's own routes — untouched by skein.
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/todos", async () => todos);
  app.post("/api/todos", async (request) => {
    const { title } = (request.body ?? {}) as { title?: string };
    const todo: Todo = { id: todos.length + 1, title: title ?? "untitled" };
    todos.push(todo);
    return todo;
  });

  // The Agent Protocol, mounted under /agent. The SDK/UI points at `<origin>/agent`.
  await app.register(skeinPlugin, { prefix: "/agent", config: configPath });

  return app;
}

export interface StartedExample {
  app: FastifyInstance;
  /** e.g. `http://127.0.0.1:2024` — the app root. The Agent Protocol lives under `${url}/agent`. */
  url: string;
  close: () => Promise<void>;
}

export async function startServer(port = 2024, host = "127.0.0.1"): Promise<StartedExample> {
  const app = await buildApp();
  await app.listen({ port, host });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { app, url: `http://${host}:${address.port}`, close: () => app.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env["PORT"]) || 2024;
  void startServer(port).then(({ url }) => {
    console.log(
      `fastify app on ${url} — its REST at ${url}/api/todos, Agent Protocol at ${url}/agent`,
    );
  });
}
