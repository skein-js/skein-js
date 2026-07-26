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

import { createNestLogger } from "./nest-logger.js";
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

/** A `Logger` is the only value `forResolvedRuntime`'s overloaded slot can hold that carries `error`. */
function isLogger(value: unknown): value is Logger {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Logger).error === "function" &&
    typeof (value as Logger).warn === "function"
  );
}

@Module({})
export class SkeinModule implements NestModule {
  /**
   * Serve the Agent Protocol from a `langgraph.json` (in-memory runtime) or an injected
   * `ProtocolDeps`. The runtime is built once, lazily, when the module initializes.
   *
   * Logging defaults to Nest's own `Logger`, so failed runs surface in the host app's output with no
   * wiring. Pass `logger` to redirect it, or `logger: false` to opt out.
   */
  static forRoot(options: SkeinRuntimeOptions): DynamicModule {
    return SkeinModule.assemble(
      {
        provide: SKEIN_RUNTIME,
        useFactory: () => resolveProtocolRuntime(options, createNestLogger()),
      },
      options.cors,
    );
  }

  /**
   * Serve the Agent Protocol over a runtime you already resolved (via `resolveProtocolRuntime`). Used
   * by `createNestServer` so the runtime — and its worker — is created exactly once.
   *
   * The logger now travels on `resolved` (`resolveProtocolRuntime` applies the whole precedence
   * chain), so the middle `logger` argument is redundant. It is still accepted — dropping a
   * positional parameter would silently reinterpret an existing 3-argument call's logger as `cors` —
   * but prefer passing `logger` to `resolveProtocolRuntime` instead.
   *
   * @param logger - @deprecated Pass the logger to `resolveProtocolRuntime`; this only overrides the
   * transport's fault logging, not the engine's.
   */
  static forResolvedRuntime(
    resolved: ResolvedProtocolRuntime,
    logger?: Logger | boolean | CorsSetting,
    cors?: boolean | CorsSetting,
  ): DynamicModule {
    // Two shapes to tell apart: the current `(resolved, cors)` and the legacy `(resolved, logger,
    // cors)`. A `Logger` is the only one of these that is an object carrying `error` — `CorsSetting`
    // never is — so the check is unambiguous rather than positional guesswork.
    const legacyLogger = isLogger(logger) ? logger : undefined;
    const effectiveCors = isLogger(logger) ? cors : (logger as boolean | CorsSetting | undefined);
    return SkeinModule.assemble(
      { provide: SKEIN_RUNTIME, useValue: resolved },
      effectiveCors,
      legacyLogger,
    );
  }

  private static assemble(
    runtimeProvider: Provider,
    cors?: boolean | CorsSetting,
    transportLogger?: Logger,
  ): DynamicModule {
    return {
      module: SkeinModule,
      providers: [
        runtimeProvider,
        // Derived from the resolved runtime rather than read off the options a second time, so the
        // transport's fault logging and the engine's can never disagree about where output goes —
        // `resolveProtocolRuntime` already applied the whole precedence chain. The override exists
        // only for the deprecated `forResolvedRuntime(resolved, logger, cors)` call shape.
        {
          provide: SKEIN_LOGGER,
          useFactory: (resolved: ResolvedProtocolRuntime): Logger | null =>
            transportLogger ?? resolved.logger ?? null,
          inject: [SKEIN_RUNTIME],
        },
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
