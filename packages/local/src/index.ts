import { MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { withStoreItems, type GraphResolver, type ProtocolDeps } from "@skein-js/agent-protocol";
import type { StoreTtlConfig, ThreadTtlConfig } from "@skein-js/core";
import {
  cloneLangGraphCheckpoint,
  normalizeEmbeddableGraphs,
  SkeinBaseStore,
  type EmbeddableGraph,
} from "@skein-js/langgraph";
import { MemoryRunEventBus, MemoryThreadEventBus } from "@skein-js/storage-memory";
import { openSqliteStorage } from "@skein-js/storage-sqlite";

import { inspectSqliteThreadStorage } from "./thread-storage.js";

export interface EmbedSqliteGraphsOptions {
  sqlitePath: string;
  maxPageSize?: number;
  ttl?: StoreTtlConfig;
  threadTtl?: ThreadTtlConfig;
  overrides?: Omit<
    Partial<ProtocolDeps>,
    | "graphs"
    | "store"
    | "queue"
    | "bus"
    | "checkpointer"
    | "storeBridge"
    | "cloneCheckpoint"
    | "ephemeralCheckpointer"
  >;
}
export interface EmbeddedSqliteRuntime {
  deps: ProtocolDeps;
  dispose(): Promise<void>;
}

/** Assemble dependencies without starting a worker, listener, or host process. */
export async function embedSqliteGraphs(
  graphs: GraphResolver | Record<string, EmbeddableGraph>,
  options: EmbedSqliteGraphsOptions,
): Promise<EmbeddedSqliteRuntime> {
  const threadTtl = options.threadTtl ?? options.overrides?.threadTtl;
  const storage = await openSqliteStorage({
    filename: options.sqlitePath,
    maxPageSize: options.maxPageSize,
    ttl: options.ttl,
    threadTtl,
  });
  try {
    const checkpointer = new SqliteSaver(storage.database);
    // deleteThread does not initialize upstream tables. A public read does, without making state.
    await checkpointer.getTuple({ configurable: { thread_id: "__skein_initialize__" } });
    const store = options.overrides?.storeItems
      ? withStoreItems(storage.store, options.overrides.storeItems)
      : storage.store;
    const deps: ProtocolDeps = {
      ...options.overrides,
      store,
      queue: storage.queue,
      bus: new MemoryRunEventBus(),
      threadBus: new MemoryThreadEventBus(),
      checkpointer,
      inspectThreadStorage: (threadId) => inspectSqliteThreadStorage(storage.database, threadId),
      graphs: normalizeEmbeddableGraphs(graphs),
      storeBridge: (items) => new SkeinBaseStore(items),
      cloneCheckpoint: cloneLangGraphCheckpoint,
      ephemeralCheckpointer: () => new MemorySaver(),
      threadTtl,
    };
    const timer = options.ttl
      ? setInterval(
          () => {
            void store.store
              .sweepExpired()
              .catch((error) => deps.logger?.error("SQLite item expiry sweep failed", error));
          },
          (options.ttl.sweepIntervalMinutes ?? 60) * 60_000,
        )
      : undefined;
    timer?.unref();
    let disposal: Promise<void> | undefined;
    return {
      deps,
      dispose() {
        disposal ??= (async () => {
          if (timer) clearInterval(timer);
          await storage.dispose();
        })();
        return disposal;
      },
    };
  } catch (error) {
    await storage.dispose();
    throw error;
  }
}
