// A `store.adapter` fixture: what a user's bring-your-own store module looks like. A real one would be
// `PostgresStore.fromConnString(...)` plus a top-level `await store.setup()`; `InMemoryStore` keeps the
// fixture dependency-free while exercising the same `BaseStore` shape.

import { InMemoryStore } from "@langchain/langgraph";

export const store = new InMemoryStore();
