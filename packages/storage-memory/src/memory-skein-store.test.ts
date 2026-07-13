import { runSkeinStoreConformance } from "@skein-js/test-support";

import { MemorySkeinStore } from "./memory-skein-store.js";

// The whole point of the memory driver in this slice: prove it satisfies the shared SkeinStore
// contract. Postgres will run this exact suite later, making the two interchangeable.
runSkeinStoreConformance("memory", () => new MemorySkeinStore());
