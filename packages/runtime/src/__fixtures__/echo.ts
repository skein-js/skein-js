// Minimal graph fixture. buildRuntime resolves graphs lazily (only on load()/schemas()), and the
// runtime integration tests never invoke a run, so this is never imported — it exists so the
// fixture langgraph.json references a real path.
export const graph = { placeholder: true };
