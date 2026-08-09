// A minimal `ProtocolDeps.storeBridge` for tests.
//
// The real bridge is `SkeinBaseStore` in `@skein-js/langgraph`, and this package deliberately cannot
// import it: `@skein-js/langgraph` depends on `@skein-js/agent-protocol`, so a dependency back — even
// a devDependency for fixtures — makes the Nx task graph circular
// (`agent-protocol:test → langgraph:build → agent-protocol:build → …`) and nothing can build.
//
// That constraint is a feature here. `storeBridge` is a *function*, so a fixture can supply its own
// in ~20 lines against `@langchain/langgraph` directly — which is the same thing a non-LangGraph
// runtime does with its own store type, and proves the seam is not LangGraph-shaped.
//
// Only `get`/`put` are implemented, because that is all `storeGraph` exercises. The production bridge
// is the one that has to be complete; see `skein-base-store.test.ts` in `@skein-js/langgraph`.

import { BaseStore, type Operation, type OperationResults } from "@langchain/langgraph";
import type { StoreRepo } from "@skein-js/core";

class FixtureStoreBridge extends BaseStore {
  constructor(private readonly repo: StoreRepo) {
    super();
  }

  async batch<Op extends readonly Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    for (const operation of operations) {
      if ("key" in operation && "value" in operation && operation.value !== null) {
        await this.repo.put([...operation.namespace], operation.key, operation.value);
        results.push(undefined);
        continue;
      }
      if ("key" in operation) {
        const item = await this.repo.get([...operation.namespace], operation.key);
        results.push(
          item
            ? {
                namespace: [...item.namespace],
                key: item.key,
                value: item.value,
                createdAt: new Date(item.createdAt),
                updatedAt: new Date(item.updatedAt),
              }
            : null,
        );
        continue;
      }
      throw new Error("FixtureStoreBridge implements only get/put");
    }
    return results as OperationResults<Op>;
  }
}

/** Bridge a `StoreRepo` into a LangGraph `BaseStore`, for fixtures only. */
export function fixtureStoreBridge(repo: StoreRepo): unknown {
  return new FixtureStoreBridge(repo);
}
