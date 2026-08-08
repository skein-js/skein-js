// `store.adapter` resolution: every failure shape produces its own actionable message, because the
// alternative is an `undefined is not a function` from inside the first request that reaches the missing
// method. The `ttl`-without-expiry case is the one that is a *refusal on purpose* rather than a
// mis-configuration: accepting a retention policy and discarding it is worse than not booting.

import { InMemoryStore } from "@langchain/langgraph";
import type { ModuleImporter } from "@skein-js/config";
import type { StoreRepo } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { RuntimeConfigError } from "./errors.js";
import { resolveStoreAdapter } from "./resolve-store-adapter.js";

/** An importer serving one in-memory module, so nothing touches disk. */
const serving =
  (exports: Record<string, unknown>): ModuleImporter =>
  async () =>
    exports;

const resolve = (exports: Record<string, unknown>, ttl?: { defaultTtl?: number }) =>
  resolveStoreAdapter("./my-store.ts:store", {
    configDir: "/app",
    importModule: serving(exports),
    ...(ttl ? { ttl } : {}),
  });

/** A `StoreRepo` whose methods exist but are never called — shape is all these cases check. */
const stubRepo = (): StoreRepo =>
  ({
    get: async () => null,
    put: async () => ({}) as never,
    delete: async () => undefined,
    search: async () => [],
    listNamespaces: async () => [],
    sweepExpired: async () => 0,
  }) satisfies StoreRepo;

describe("resolveStoreAdapter", () => {
  it("wraps a LangGraph BaseStore, so it serves the whole /store surface", async () => {
    const repo = await resolve({ store: new InMemoryStore() });

    await repo.put(["ns"], "k", { v: 1 });
    expect((await repo.get(["ns"], "k"))?.value).toEqual({ v: 1 });
  });

  it("takes a skein StoreRepo directly, without adapting it", async () => {
    const repo = stubRepo();

    expect(await resolve({ store: repo })).toBe(repo);
  });

  it("names the missing export rather than failing later on undefined", async () => {
    await expect(resolve({ somethingElse: new InMemoryStore() })).rejects.toThrow(
      /has no export "store"/,
    );
  });

  it("reports a non-object export, and says a factory is not accepted", async () => {
    await expect(resolve({ store: () => new InMemoryStore() })).rejects.toThrow(
      /is function, expected a LangGraph `BaseStore` or a skein `StoreRepo`/,
    );
  });

  it("names the first missing StoreRepo method on a half-built adapter", async () => {
    const { search: _dropped, ...incomplete } = stubRepo();

    await expect(resolve({ store: incomplete })).rejects.toThrow(/no `search` method/);
  });

  it("wraps an import failure, keeping the underlying cause", async () => {
    const boom = new Error("bad import");
    const failing: ModuleImporter = async () => {
      throw boom;
    };

    const thrown = await resolveStoreAdapter("./my-store.ts:store", {
      configDir: "/app",
      importModule: failing,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RuntimeConfigError);
    expect((thrown as Error).message).toMatch(/failed to import module/);
    expect((thrown as Error).cause).toBe(boom);
  });

  it("refuses a configured store.ttl the adapted store cannot honour", async () => {
    // `InMemoryStore` exposes no `sweepExpiredItems`, so TTL is unreachable through it. Booting anyway
    // would leave an operator believing items expire when nothing ever removes them.
    await expect(resolve({ store: new InMemoryStore() }, { defaultTtl: 60 })).rejects.toThrow(
      /cannot expire items/,
    );
  });

  it("accepts store.ttl when the adapted store can sweep", async () => {
    // How `PostgresStore` declares the capability — the same duck-type the adapter detects.
    class Sweeping extends InMemoryStore {
      sweepExpiredItems = async (): Promise<number> => 0;
    }

    const repo = await resolveStoreAdapter("./my-store.ts:store", {
      configDir: "/app",
      importModule: serving({ store: new Sweeping() }),
      ttl: { defaultTtl: 60, refreshOnRead: false },
    });

    expect(await repo.sweepExpired()).toBe(0);
  });

  it("does not refuse an empty store.ttl block, which asks for nothing", async () => {
    await expect(resolve({ store: new InMemoryStore() }, {})).resolves.toBeDefined();
  });

  it("refuses default_ttl alone, because refresh-on-read defaults to enabled", async () => {
    // The dangerous case. `refreshOnRead` absent means *enabled* (both drivers test `!== false`), so
    // booting on `{ default_ttl: 60 }` would delete an item 60 minutes after its last write no matter how
    // often it was read — silent data loss on a config that reads as ordinary retention.
    class Sweeping extends InMemoryStore {
      sweepExpiredItems = async (): Promise<number> => 0;
    }

    await expect(
      resolveStoreAdapter("./my-store.ts:store", {
        configDir: "/app",
        importModule: serving({ store: new Sweeping() }),
        ttl: { defaultTtl: 60 },
      }),
    ).rejects.toThrow(/refresh-on-read/);
  });

  it("accepts default_ttl once refresh_on_read is explicitly opted out of", async () => {
    class Sweeping extends InMemoryStore {
      sweepExpiredItems = async (): Promise<number> => 0;
    }

    await expect(
      resolveStoreAdapter("./my-store.ts:store", {
        configDir: "/app",
        importModule: serving({ store: new Sweeping() }),
        ttl: { defaultTtl: 60, refreshOnRead: false },
      }),
    ).resolves.toBeDefined();
  });

  it("refuses store.ttl against a StoreRepo adapter, which skein's config never reaches", async () => {
    // A `StoreRepo` implements expiry itself (`put` takes a `ttl`, `sweepExpired()` is on the interface),
    // but nothing injects skein's `store.ttl` into one — so accepting it would be the same silent
    // non-application the `BaseStore` branch refuses.
    await expect(resolve({ store: stubRepo() }, { defaultTtl: 60 })).rejects.toThrow(
      /owns its own.*expiry/s,
    );
  });

  it("refuses store.index, which configures the store the adapter replaces", async () => {
    await expect(
      resolveStoreAdapter("./my-store.ts:store", {
        configDir: "/app",
        importModule: serving({ store: new InMemoryStore() }),
        indexConfigured: true,
      }),
    ).rejects.toThrow(/no effect on search/);
  });

  it("calls start() so an uninitialized store fails at boot, not at the first request", async () => {
    let started = false;
    class Starting extends InMemoryStore {
      override async start(): Promise<void> {
        started = true;
      }
    }

    await resolveStoreAdapter("./my-store.ts:store", {
      configDir: "/app",
      importModule: serving({ store: new Starting() }),
    });

    expect(started).toBe(true);
  });

  it("surfaces a failing start() as an actionable config error", async () => {
    class Failing extends InMemoryStore {
      override async start(): Promise<void> {
        throw new Error("no connection");
      }
    }

    const thrown = await resolveStoreAdapter("./my-store.ts:store", {
      configDir: "/app",
      importModule: serving({ store: new Failing() }),
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RuntimeConfigError);
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  it("registers teardown before a refusal, so a refused boot does not leak the store", async () => {
    // The store was constructed at import time and may already hold a pool. A config it cannot satisfy
    // must still shut it down, so the disposer is registered ahead of every assertion.
    let stopped = false;
    class Closing extends InMemoryStore {
      override async stop(): Promise<void> {
        stopped = true;
      }
    }
    const disposers: (() => Promise<unknown>)[] = [];

    await expect(
      resolveStoreAdapter("./my-store.ts:store", {
        configDir: "/app",
        importModule: serving({ store: new Closing() }),
        disposers,
        ttl: { defaultTtl: 60 },
      }),
    ).rejects.toThrow();

    expect(disposers).toHaveLength(1);
    await disposers[0]?.();
    expect(stopped).toBe(true);
  });

  it("registers the adapted store's stop() for teardown, so a pool is not leaked", async () => {
    let stopped = false;
    class Closing extends InMemoryStore {
      override async stop(): Promise<void> {
        stopped = true;
      }
    }
    const disposers: (() => Promise<unknown>)[] = [];

    await resolveStoreAdapter("./my-store.ts:store", {
      configDir: "/app",
      importModule: serving({ store: new Closing() }),
      disposers,
    });
    expect(disposers).toHaveLength(1);

    await disposers[0]?.();
    expect(stopped).toBe(true);
  });

  it("refuses store.ttl.refresh_on_read, which no BaseStore can express", async () => {
    // `default_ttl` is honourable — the adapter stamps it onto writes. Refresh-on-read is not:
    // `BaseStore.get` has no way to extend an expiry, so accepting it would mean active items quietly
    // expiring anyway. Refused even on a store that *can* sweep, because sweeping is not the missing part.
    class Sweeping extends InMemoryStore {
      sweepExpiredItems = async (): Promise<number> => 0;
    }

    await expect(
      resolveStoreAdapter("./my-store.ts:store", {
        configDir: "/app",
        importModule: serving({ store: new Sweeping() }),
        ttl: { defaultTtl: 60, refreshOnRead: true },
      }),
    ).rejects.toThrow(/refresh_on_read/);
  });
});
