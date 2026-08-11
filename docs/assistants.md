# Assistants

An assistant is a named, versioned configuration of one graph. It's how you ship a prompt change or a
model swap without redeploying — and how you roll it back when the change was wrong.

## You already have one

Every graph in your `langgraph.json` is registered as an assistant at startup, with
`assistant_id` equal to `graph_id`. So this works on a fresh server with nothing configured:

```ts
await client.runs.wait(threadId, "agent", { input }); // "agent" is the graph id *and* an assistant id
```

If you never need more than one configuration per graph, you can stop reading here. Assistants become
useful when you want **several** configurations of the same graph.

## Several configurations of one graph

```ts
const support = await client.assistants.create({
  graphId: "agent",
  name: "support-tone",
  config: { configurable: { system_prompt: "Be concise and formal." } },
});

await client.runs.wait(threadId, support.assistant_id, { input });
```

Whatever you put in `config.configurable` arrives in your graph as `config.configurable`. That's the
seam: the graph stays one deployment, and the assistant decides how it behaves.

This is what makes per-tenant or per-plan behaviour tractable — one assistant per tenant, rather than
branching inside the graph on metadata you have to thread through every node.

## Versioning and rollback

**Every `PATCH` mints a new immutable version.** The live assistant tracks whichever version is
current, so changing a prompt is a `PATCH`, and undoing it is one call:

```ts
await client.assistants.update(assistantId, {
  config: { configurable: { system_prompt: "Be warm and brief." } },
}); // now version 2

await client.assistants.getVersions(assistantId); // newest first
await client.assistants.setLatest(assistantId, 1); // back to version 1
```

Rollback points the assistant at an existing version — it doesn't delete the newer one, so you can go
forward again. Nothing is lost by trying a change.

**Runs record which assistant they used**, so a thread tells you what configuration produced it. What
a version does _not_ capture is your graph's code: rolling back an assistant restores config, not the
deployment. If the bad change was in a node, roll back the deploy.

## Inspect what a graph expects

Useful when you're building a UI against a graph you didn't write, or checking what a config change is
allowed to set:

| You want                          | Call                                          |
| --------------------------------- | --------------------------------------------- |
| Input/output/state/config schemas | `client.assistants.getSchemas(assistantId)`   |
| The drawable graph                | `client.assistants.getGraph(assistantId)`     |
| Subgraph schemas by namespace     | `client.assistants.getSubgraphs(assistantId)` |

The [console](./console.md) renders all three — schemas, graph shape, and version history — so it's
usually faster to look there than to call them.

## Housekeeping

```ts
await client.assistants.search({ graphId: "agent" }); // filter by graph, name or metadata
await client.assistants.delete(assistantId);
```

Two things to know before deleting:

- **`delete(id, { deleteThreads: true })` cascades** to the threads that assistant owns. Without it,
  the threads stay and keep their history.
- **Deleting a graph-registered assistant doesn't stop the graph.** It's re-registered on the next
  boot, since registration is keyed on the graph id.

## What you must get right

- **`assistant_id` is not a graph id once you create your own.** Runs take an assistant id; a graph id
  only works because of the startup registration. Store the id you got back from `create`.
- **`config.configurable` is the contract with your graph.** Nothing validates that an assistant's
  config matches what the graph reads — a typo'd key is silently ignored rather than rejected. Check
  `getSchemas` if you're unsure of the shape.
- **`create` defaults to `if_exists: "raise"`.** Pass `"do_nothing"` if you're seeding assistants at
  startup and want the call to be idempotent.

## Working example

There's no dedicated example yet. The [console](./console.md)'s Assistants view is the practical way
to see versioning: edit an assistant's config, run it from the playground, then roll back.

## See also

- [Runs](./runs.md) — passing an assistant id to a run
- [The console](./console.md) — schemas, graph shape, version history in a UI
- [LangGraph CLI compatibility](./langgraph-cli-compat.md) — how `graphs` entries become assistants
- [Agent Protocol](./agent-protocol.md#assistants) — every assistant endpoint and field
