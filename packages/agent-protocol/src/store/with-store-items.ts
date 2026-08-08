// Substitutes just the long-term-memory repo of a `SkeinStore`, leaving its other five repos, its bounds
// and any driver-specific methods intact. The one audited place that composition happens.
//
// It exists because the obvious spelling is a trap. `{ ...postgresStore, store: mine }` looks right and
// is wrong in two ways, both invisible at the type level:
//
//   - `maxPageSize` and `durable` are class **getters**, and object spread copies own enumerable
//     properties only — a prototype accessor is silently dropped, so the page bound reads as
//     `undefined`. Both fields are optional on the interface, so nothing type-checks the mistake.
//     `createAuthScopedStore` already documents and works around exactly this.
//   - Driver methods *beyond* the interface are dropped too. `restore()` is the bulk loader
//     `skein import-langgraph` duck-types for; a spread turns that into "target store does not support
//     bulk import" on a store that does.
//
// A prototype clone (`Object.create(inner)`) does not fix it either, and it is worth saying why, because
// it looks like it should: both drivers' getters read **private** fields (`this.#maxPageSize`), and a
// private field belongs to the instance that declared it, not to anything down the prototype chain. So
// reading `maxPageSize` off a clone throws `Cannot read private member #maxPageSize from an object whose
// class did not declare it` — a crash rather than the spread's silent `undefined`.
//
// What works is a proxy that keeps `this` pointing at the original: getters run against the instance that
// owns their private state, methods stay bound to it, and only `store` is answered differently.

import type { SkeinStore, StoreRepo } from "@skein-js/core";

/**
 * `inner` with its `store` repo replaced by `storeItems`, and everything else — the bounds, the other
 * five repos, driver extras like `restore()` — served from `inner` itself.
 *
 * `inner` is never mutated, so a caller still holding it sees its own store repo.
 */
export function withStoreItems(inner: SkeinStore, storeItems: StoreRepo): SkeinStore {
  return new Proxy(inner, {
    get(target, property) {
      if (property === "store") return storeItems;
      // `target` is passed as the receiver deliberately: a getter must run with `this` bound to the
      // instance that declared its private fields, and a method must stay bound to it for the same
      // reason. Handing the proxy through as receiver is what reintroduces the private-field crash.
      const value = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as SkeinStore;
}
