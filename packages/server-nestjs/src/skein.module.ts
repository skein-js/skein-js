// `SkeinModule` — the NestJS dynamic module that serves the Agent Protocol. It builds the runtime
// (in-memory from `{ config }`, or injected `{ deps }`), wires the transport middleware for every
// route (the middleware only claims skein's paths and passes the rest through, applying CORS to those
// routes), and stops the background worker on shutdown. Import it to serve the protocol alongside your
// own controllers:
//
// ```ts
// @Module({ imports: [SkeinModule.forRoot({ config: "./langgraph.json" })] })
// export class AppModule {}
// ```

import {
  Inject,
  Injectable,
  Module,
  RequestMethod,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type Provider,
} from "@nestjs/common";
import type { Logger } from "@skein-js/agent-protocol";
import {
  resolveProtocolRuntime,
  type CorsSetting,
  type ResolvedProtocolRuntime,
  type SkeinRuntimeOptions,
} from "@skein-js/server-kit";

import { SkeinMiddleware } from "./skein.middleware.js";
import { SKEIN_CORS, SKEIN_LOGGER, SKEIN_RUNTIME } from "./tokens.js";

/**
 * Stops the background run worker BEFORE the HTTP server closes. Nest runs `beforeApplicationShutdown`
 * ahead of `dispose()` (which closes the server), so stopping the worker here lets in-flight SSE
 * streams settle — otherwise the server close would block on those streams while the worker still
 * feeds them.
 */
@Injectable()
class SkeinWorkerLifecycle implements BeforeApplicationShutdown {
  constructor(@Inject(SKEIN_RUNTIME) private readonly resolved: ResolvedProtocolRuntime) {}
  async beforeApplicationShutdown(): Promise<void> {
    await this.resolved.runtime.worker.stop();
  }
}

@Module({})
export class SkeinModule implements NestModule {
  /**
   * Serve the Agent Protocol from a `langgraph.json` (in-memory runtime) or an injected
   * `ProtocolDeps`. The runtime is built once, lazily, when the module initializes.
   */
  static forRoot(options: SkeinRuntimeOptions): DynamicModule {
    return SkeinModule.assemble(
      { provide: SKEIN_RUNTIME, useFactory: () => resolveProtocolRuntime(options) },
      options.logger,
      options.cors,
    );
  }

  /**
   * Serve the Agent Protocol over a runtime you already resolved (via `resolveProtocolRuntime`). Used
   * by `createNestServer` so the runtime — and its worker — is created exactly once.
   */
  static forResolvedRuntime(
    resolved: ResolvedProtocolRuntime,
    logger?: Logger,
    cors?: boolean | CorsSetting,
  ): DynamicModule {
    return SkeinModule.assemble({ provide: SKEIN_RUNTIME, useValue: resolved }, logger, cors);
  }

  private static assemble(
    runtimeProvider: Provider,
    logger?: Logger,
    cors?: boolean | CorsSetting,
  ): DynamicModule {
    return {
      module: SkeinModule,
      providers: [
        runtimeProvider,
        { provide: SKEIN_LOGGER, useValue: logger ?? null },
        { provide: SKEIN_CORS, useValue: cors ?? null },
        SkeinMiddleware,
        SkeinWorkerLifecycle,
      ],
      exports: [SKEIN_RUNTIME],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Apply to every route; the middleware itself claims only skein's protocol paths and calls
    // `next()` for everything else, so the host app's own routes are untouched.
    consumer.apply(SkeinMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
