// `SkeinInvokeModule` — the NestJS dynamic module for the simplified serving surface. It mounts every
// declared graph as a plain endpoint (`POST /invoke/:graph_id`) that runs it to completion and returns
// its final state. Separate from `SkeinModule` on purpose — this is the whole surface for a non-chat
// service (no threads, assistants, or runs), and importing both modules serves both. See
// docs/serving-a-single-graph.md.
//
// ```ts
// @Module({ imports: [SkeinInvokeModule.forRoot({ deps })] })
// export class AppModule {}
// ```

import {
  Module,
  RequestMethod,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import {
  createGraphInvokeHandler,
  createRouteMatcher,
  graphInvokeRoutes,
  type GraphInvokeOptions,
} from "@skein-js/agent-protocol";
import {
  resolveRuntimeDeps,
  type CorsSetting,
  type SkeinRuntimeOptions,
} from "@skein-js/server-kit";

import { SkeinInvokeMiddleware, type ResolvedInvokeSurface } from "./skein-invoke.middleware.js";
import { SKEIN_CORS, SKEIN_INVOKE, SKEIN_LOGGER } from "./tokens.js";

export type SkeinInvokeModuleOptions = SkeinRuntimeOptions &
  GraphInvokeOptions & {
    /** Path prefix for the endpoint; defaults to `/invoke` (→ `POST /invoke/:graph_id`). */
    prefix?: string;
  };

@Module({})
export class SkeinInvokeModule implements NestModule {
  /**
   * Serve the invoke surface from a `langgraph.json` (in-memory drivers) or an injected
   * `ProtocolDeps`. Deps are resolved once, lazily, when the module initializes — no assistants are
   * seeded and no background run worker is started, so there is nothing to shut down.
   */
  static forRoot(options: SkeinInvokeModuleOptions): DynamicModule {
    return {
      module: SkeinInvokeModule,
      providers: [
        {
          provide: SKEIN_INVOKE,
          useFactory: async (): Promise<ResolvedInvokeSurface> => {
            const { deps, cors } = await resolveRuntimeDeps(options);
            return {
              handler: createGraphInvokeHandler(deps, { streamMode: options.streamMode }),
              match: createRouteMatcher(graphInvokeRoutes(options.prefix)),
              cors: cors as CorsSetting | undefined,
            };
          },
        },
        { provide: SKEIN_LOGGER, useValue: options.logger ?? null },
        { provide: SKEIN_CORS, useValue: options.cors ?? null },
        SkeinInvokeMiddleware,
      ],
      exports: [SKEIN_INVOKE],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Apply to every route; the middleware claims only the invoke path and calls `next()` otherwise,
    // so the host app's own routes are untouched.
    consumer.apply(SkeinInvokeMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
