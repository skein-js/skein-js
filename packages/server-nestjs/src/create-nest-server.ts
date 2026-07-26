// The lifecycle-owning convenience: a ready NestJS application serving the Agent Protocol at the
// root, plus `listen`/`close`. This is the standalone equivalent of `createExpressServer` — a
// dedicated server whose only job is to serve the graphs. To instead mount the protocol inside an
// existing NestJS app, import `SkeinModule.forRoot(...)`.
//
// Targets NestJS's default Express platform (`@nestjs/platform-express`).

import { ConsoleLogger, Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { ProtocolRuntime } from "@skein-js/agent-protocol";
import { resolveProtocolRuntime, type SkeinRuntimeOptions } from "@skein-js/server-kit";

import { createNestLogger } from "./nest-logger.js";
import { SkeinModule } from "./skein.module.js";

/** Dependency-free liveness probe (`GET /ok`), mirroring the LangGraph platform's `/ok`. */
@Controller()
class SkeinHealthController {
  @Get("ok")
  ok(): { ok: true } {
    return { ok: true };
  }
}

export interface SkeinNestServer {
  /** The Nest application, protocol mounted at `/`. */
  app: INestApplication;
  /** The wired runtime (assistants, handlers, worker). */
  runtime: ProtocolRuntime;
  /** Start listening; resolves once bound. Defaults to port 2024. */
  listen(port?: number, host?: string): Promise<INestApplication>;
  /** Close the application, which stops the run worker via the module's shutdown hook. */
  close(): Promise<void>;
}

/** Build a NestJS server hosting the Agent Protocol, ready to `listen`. */
export async function createNestServer(options: SkeinRuntimeOptions): Promise<SkeinNestServer> {
  // Resolve the runtime once here (not inside the module) so `close()` and the module's shutdown hook
  // act on the same worker.
  //
  // The default logger differs from the embedded `SkeinModule.forRoot` case, and has to. This server
  // keeps Nest's bootstrap chatter off via `{ logger: false }` below, which silences the *global*
  // `Logger` facade — so the facade-backed default would write nowhere. A directly-constructed
  // `ConsoleLogger` isn't subject to that global override, so a standalone server still reports its
  // failed runs. Embedded, skein borrows the host's logging config; standalone, it owns it.
  const resolved = await resolveProtocolRuntime(
    options,
    createNestLogger({ logger: new ConsoleLogger("Skein") }),
  );

  // CORS is applied by SkeinModule's middleware (scoped to skein routes), not `app.enableCors`, so it
  // works identically here and in the embedded `SkeinModule.forRoot` case.
  @Module({
    imports: [SkeinModule.forResolvedRuntime(resolved, options.cors)],
    controllers: [SkeinHealthController],
  })
  class SkeinRootModule {}

  const app = await NestFactory.create(SkeinRootModule, { logger: false });
  app.enableShutdownHooks();

  return {
    app,
    runtime: resolved.runtime,
    listen: async (port = 2024, host = "localhost") => {
      await app.listen(port, host);
      return app;
    },
    close: () => app.close(),
  };
}
