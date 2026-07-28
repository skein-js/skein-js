// `@skein-js/server-kit/dev` — importing a `langgraph dev` state directory into skein's own drivers.
//
// A subpath rather than part of the root barrel, because these three functions drag `superjson`,
// `node:fs/promises` and the `langgraph.json` loader in with them. Kept in the barrel, every framework
// adapter carried a filesystem + snapshot deserializer it never calls, on a path that only ever runs
// under the CLI. There is deliberately **no** re-export from the root: a re-export is still a static
// import, so it would defeat the split entirely. Guarded by `static-imports.test.ts`.

export {
  describeSnapshot,
  loadSnapshotIntoStore,
  readLanggraphDevState,
} from "./langgraph-import.js";
export type { DevStateCounts } from "./langgraph-import.js";
