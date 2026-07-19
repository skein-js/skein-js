// skein-js embedded in an existing NestJS app: the app keeps its own REST controller AND serves the
// Agent Protocol via `SkeinModule.forRoot(...)`. SkeinModule mounts as middleware that claims only
// skein's protocol paths (`/threads`, `/assistants`, `/runs`, `/store`) and passes everything else
// through — so the app's `/api/todos` controller is untouched. The protocol follows the app's
// `setGlobalPrefix("api")`, so it is served under `/api` too. Run with `tsx src/main.ts`.

// NestJS's DI reads decorator metadata via reflect-metadata; load it before any Nest code runs.
import "reflect-metadata";

import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SkeinModule } from "@skein-js/nestjs";

const configPath = fileURLToPath(new URL("../langgraph.json", import.meta.url));

// The app's own in-memory "todos" — a stand-in for whatever REST your product already serves.
interface Todo {
  id: number;
  title: string;
}
const todos: Todo[] = [{ id: 1, title: "Try skein-js" }];

// Prefix-relative: `setGlobalPrefix("api")` below puts this at `/api/todos`.
@Controller("todos")
class TodosController {
  @Get()
  list(): Todo[] {
    return todos;
  }

  @Post()
  create(@Body() body: { title?: string }): Todo {
    const todo: Todo = { id: todos.length + 1, title: body?.title ?? "untitled" };
    todos.push(todo);
    return todo;
  }
}

@Module({
  imports: [SkeinModule.forRoot({ config: configPath })],
  controllers: [TodosController],
})
class AppModule {}

export interface StartedExample {
  app: INestApplication;
  /** e.g. `http://127.0.0.1:2024` — the Agent Protocol is served under `${url}/api`. */
  url: string;
  close: () => Promise<void>;
}

export async function startServer(port = 2024, host = "127.0.0.1"): Promise<StartedExample> {
  const app = await NestFactory.create(AppModule, { logger: false });
  // The app's own convention — skein picks it up automatically, no configuration needed.
  app.setGlobalPrefix("api");
  app.enableShutdownHooks(); // so the skein run worker drains on close()
  await app.listen(port, host);
  const address = app.getHttpServer().address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { app, url: `http://${host}:${address.port}`, close: () => app.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env["PORT"]) || 2024;
  void startServer(port).then(({ url }) => {
    console.log(
      `nestjs app on ${url} — its REST at ${url}/api/todos, Agent Protocol at ${url}/api`,
    );
  });
}
