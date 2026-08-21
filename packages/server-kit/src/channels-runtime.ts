// Turning a `skein.channels` block into a route table and a handler, without making channels
// mandatory for everyone else.
//
// `@skein-js/channels` is imported **dynamically, and only when a channel is configured**. That is
// what keeps the feature genuinely optional: a deployment that never writes the config block does not
// install the package, does not load it, and serves no channel routes — it cannot tell the feature
// exists, which is the goal it was designed against. A static import here would drag the package into
// every skein server on npm.

import type {
  ProtocolDeps,
  ProtocolHandlerExtras,
  ProtocolRequest,
  ProtocolResponse,
  ProtocolService,
  RouteBinding,
  RouteAuthz,
  WebhookDispatcher,
} from "@skein-js/agent-protocol";
import { SkeinConfigError } from "@skein-js/config";
import type { LoadedChannel } from "@skein-js/config";
import { SkeinHttpError, type AuthContext, type Metadata } from "@skein-js/core";

/**
 * The outbox dispatcher, as this module composes it.
 *
 * Aliased to `WebhookDispatcher` rather than restated: the wrapper has to be droppable straight back
 * onto `deps.webhookDispatcher`, and a structurally similar type with a looser `attempt` would not be
 * assignable in that direction.
 */
type Dispatcher = WebhookDispatcher;

/** What the channel surface adds to a runtime: routes to mount, and the handler they dispatch into. */
export interface ResolvedChannels {
  routes: readonly RouteBinding[];
  handlers: ProtocolHandlerExtras;
  /**
   * Wrap the deployment's delivery dispatcher so a channel's replies ride the outbox.
   *
   * Applied to `deps` before the runtime is built, so a channel reply is written in the run's finalize
   * transaction and retried by the same worker as any webhook — no second mechanism to make crash-safe.
   */
  wrapDispatcher(inner: Dispatcher): Dispatcher;
}

export interface ResolveChannelsInput {
  channels: Record<string, LoadedChannel>;
  /** Graph ids this deployment serves, for validating each channel's `assistant` at boot. */
  graphIds: readonly string[];
  deps: ProtocolDeps;
  /**
   * The runtime's service, read lazily.
   *
   * A getter rather than the value, because of an ordering knot: the handler this builds has to be
   * handed to `createProtocolRuntime`, and the service only exists once that call returns. Routes do
   * not have the problem — the registry needs only config and modules — so only the request path
   * defers, and by the time a request arrives the runtime is long since built.
   */
  service(): ProtocolService;
}

/**
 * Build the channel routes and handler, or `undefined` when nothing is configured.
 *
 * Every validation failure here is a **boot** failure. Discovering that `assistant` names a graph
 * that does not exist when the first customer sends a message is precisely what this avoids.
 */
export async function resolveChannels(
  input: ResolveChannelsInput,
): Promise<ResolvedChannels | undefined> {
  const names = Object.keys(input.channels);
  if (names.length === 0) return undefined;

  const channels = await importChannelsPackage(names);
  const registry = channels.buildChannelRegistry({
    channels: Object.fromEntries(
      Object.entries(input.channels).map(([name, loaded]) => [
        name,
        {
          module: loaded.module,
          config: {
            assistant: loaded.assistant,
            ...(loaded.allowedAssistants ? { allowedAssistants: loaded.allowedAssistants } : {}),
            ...(loaded.publicUrl ? { publicUrl: loaded.publicUrl } : {}),
          },
        },
      ]),
    ),
    graphIds: input.graphIds,
  });

  const pipelineDeps = buildPipelineDeps(input.deps, input.service);

  return {
    routes: channels.channelRouteBindings(registry.names),
    wrapDispatcher: (inner) =>
      channels.wrapChannelDispatcher({
        registry,
        inner,
        logger: input.deps.logger ?? console,
      }),
    handlers: {
      handleInboundEvent: async (req: ProtocolRequest): Promise<ProtocolResponse> => {
        // The route is one literal path per channel, so the name is recoverable from the path and an
        // unconfigured one never dispatches here at all.
        const name = req.url.split("?")[0]!.split("/channels/")[1] ?? "";
        const registered = registry.get(name);
        if (!registered) throw SkeinHttpError.notFound(`No channel named "${name}".`);
        return channels.handleInboundEvent(
          registered,
          {
            method: req.method,
            url: req.url,
            headers: req.headers,
            ...(typeof req.body === "string" ? { text: req.body } : {}),
          },
          pipelineDeps,
        );
      },
    },
  };
}

/**
 * The seam between the pipeline and this server.
 *
 * Built here rather than inside `@skein-js/channels` so that package never has to know how a runtime
 * was assembled — it takes an interface, and this is the only place that knows the answer.
 */
function buildPipelineDeps(deps: ProtocolDeps, service: () => ProtocolService) {
  return {
    ...(deps.store.idempotency ? { idempotency: deps.store.idempotency } : {}),
    clock: () => (deps.clock ? deps.clock() : new Date()),
    logger: deps.logger ?? console,

    authorize: async (
      principal: { identity: string; permissions?: string[]; metadata?: Record<string, unknown> },
      authz: RouteAuthz,
    ): Promise<AuthContext | undefined> => {
      // No Auth block: the deployment authorizes nothing, and the channel's signature is the whole
      // check — which is the same posture every other route has on such a server.
      if (!deps.auth) return undefined;
      // The provider-verified identity becomes an ordinary principal, so `@auth.on.threads` handlers
      // see it and ownership filters apply. `AuthUser`'s index signature is already open, so extra
      // provider metadata rides along the way a JWT's claims would.
      const context: AuthContext = {
        user: {
          identity: principal.identity,
          display_name: principal.identity,
          is_authenticated: true,
          permissions: principal.permissions ?? [],
          ...(principal.metadata ?? {}),
        },
        scopes: principal.permissions ?? [],
      };
      await deps.auth.authorize({
        resource: authz.resource,
        action: authz.action,
        value: {},
        context,
      });
      return context;
    },

    ensureThread: async (threadId: string, metadata: Metadata) => {
      // `ifExists: "do_nothing"` makes this atomically get-or-create, so a first message and a
      // hundredth take the same path with no read-then-create race between them.
      await service().threads.create({ thread_id: threadId, metadata, ifExists: "do_nothing" });
    },

    threadStatus: async (threadId: string) => {
      const thread = await service()
        .threads.get(threadId)
        .catch(() => null);
      return thread?.status ?? null;
    },

    createRun: async (input: {
      threadId: string;
      assistantId: string;
      input?: unknown;
      command?: { resume?: unknown };
      ifThreadStatus?: readonly ("idle" | "busy" | "interrupted" | "error")[];
      multitaskStrategy?: "reject" | "interrupt" | "rollback" | "enqueue";
      streamMode: readonly string[];
      metadata?: Metadata;
      webhook?: string;
    }) => {
      // The service, not HTTP. The pipeline runs in-process, so it never meets the SDK's missing
      // `headers` field or `AsyncCaller`'s retries — both of which forced the hand-written version of
      // this to drop to raw `fetch`.
      const run = await service().runs.createBackground(input.threadId, {
        assistant_id: input.assistantId,
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.ifThreadStatus ? { if_thread_status: [...input.ifThreadStatus] } : {}),
        ...(input.multitaskStrategy ? { multitask_strategy: input.multitaskStrategy } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.webhook ? { webhook: input.webhook } : {}),
        stream_mode: [...input.streamMode] as never,
      });
      return { runId: run.run_id };
    },
  };
}

/** The shape this module uses from `@skein-js/channels`, so the dynamic import stays typed. */
interface ChannelsModule {
  buildChannelRegistry(input: {
    channels: Record<string, { module: unknown; config: Record<string, unknown> }>;
    graphIds: readonly string[];
  }): { names: readonly string[]; get(name: string): unknown };
  channelRouteBindings(names: readonly string[]): RouteBinding[];
  wrapChannelDispatcher(options: {
    registry: unknown;
    inner: Dispatcher;
    logger: { warn(message: string, error?: unknown): void };
  }): Dispatcher;
  handleInboundEvent(registered: unknown, raw: unknown, deps: unknown): Promise<ProtocolResponse>;
}

async function importChannelsPackage(names: readonly string[]): Promise<ChannelsModule> {
  try {
    return (await import("@skein-js/channels")) as unknown as ChannelsModule;
  } catch (cause) {
    throw new SkeinConfigError(
      `skein.channels configures ${names.join(", ")}, but @skein-js/channels is not installed. ` +
        `Add it as a dependency.`,
      { cause },
    );
  }
}
