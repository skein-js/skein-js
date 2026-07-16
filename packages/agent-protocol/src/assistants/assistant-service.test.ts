import type { AuthEngine } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext, type ProtocolContext } from "../context.js";
import type { ProtocolDeps } from "../deps.js";
import { createThreadService } from "../threads/thread-service.js";

import { createAssistantService } from "./assistant-service.js";

/** An engine that scopes every resource to `metadata.owner === identity` (like the auth-scoped store). */
function ownerScopedEngine(identity: string): AuthEngine {
  return {
    enabled: true,
    studioAuthDisabled: false,
    authenticate: async () => ({
      user: { identity, display_name: identity, is_authenticated: true, permissions: [] },
      scopes: [],
    }),
    authorize: async ({ value }) => ({ filters: { owner: identity }, value }),
    matchesFilters: (metadata, filters) =>
      !filters || Object.entries(filters).every(([key, value]) => metadata?.[key] === value),
  };
}

/** Build the assistant service wired to a real thread service (needed for the delete cascade). */
function makeService(overrides: Partial<ProtocolDeps> = {}) {
  const ctx = createContext(createFixtureDeps(overrides));
  const service = createAssistantService(ctx, createThreadService(ctx));
  return { service, deps: ctx.deps };
}

describe("assistant service", () => {
  it("registers one assistant per graph, id defaulting to graph_id, idempotently", async () => {
    const { service } = makeService();

    const first = await service.registerGraphAssistants();
    expect(first.map((a) => a.assistant_id).sort()).toEqual([
      "echo",
      "interrupting",
      "slow",
      "store",
      "throwing",
    ]);
    expect((await service.get("echo")).graph_id).toBe("echo");

    // Second registration doesn't duplicate.
    await service.registerGraphAssistants();
    expect((await service.list()).length).toBe(5);
  });

  it("returns schemas for a known assistant and 404s an unknown one", async () => {
    const { service } = makeService();
    await service.registerGraphAssistants();

    expect(await service.schemas("echo")).toEqual({ echo: { graph_id: "echo" } });
    await expect(service.schemas("ghost")).rejects.toMatchObject({ status: 404 });
    await expect(service.get("ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("searches and counts by graph_id, name, and metadata", async () => {
    const { service } = makeService();
    await service.registerGraphAssistants();
    await service.create({ graph_id: "echo", name: "Tagged", metadata: { team: "core" } });

    expect((await service.search({ graph_id: "echo" })).length).toBe(2);
    const byName = await service.search({ name: "Tagged" });
    expect(byName).toHaveLength(1);
    expect(byName[0]?.metadata).toMatchObject({ team: "core" });
    expect(await service.count({ metadata: { team: "core" } })).toBe(1);
    expect(await service.count({ graph_id: "echo" })).toBe(2);
  });

  it("creates honoring if_exists (raise by default, do_nothing returns the existing)", async () => {
    const { service } = makeService();

    const created = await service.create({ graph_id: "echo", assistant_id: "custom" });
    expect(created).toMatchObject({ assistant_id: "custom", graph_id: "echo", version: 1 });

    await expect(
      service.create({ graph_id: "echo", assistant_id: "custom" }),
    ).rejects.toMatchObject({ status: 409 });

    const again = await service.create({
      graph_id: "echo",
      assistant_id: "custom",
      ifExists: "do_nothing",
      metadata: { ignored: true },
    });
    expect(again.assistant_id).toBe("custom");
    expect(again.metadata).toEqual({}); // unchanged — the existing row was returned
  });

  it("updates by minting a new version, lists history newest-first, and rolls back", async () => {
    const { service } = makeService();
    const created = await service.create({
      graph_id: "echo",
      assistant_id: "a",
      metadata: { env: "dev" },
    });
    expect(created.version).toBe(1);

    const updated = await service.update("a", { metadata: { env: "prod" } });
    expect(updated.version).toBe(2);
    expect(updated.metadata).toEqual({ env: "prod" });

    const versions = await service.listVersions("a");
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]?.metadata).toEqual({ env: "dev" });

    const rolledBack = await service.setLatest("a", 1);
    expect(rolledBack.version).toBe(1);
    expect(rolledBack.metadata).toEqual({ env: "dev" });

    await expect(service.setLatest("a", 99)).rejects.toMatchObject({ status: 404 });
    await expect(service.listVersions("ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("deletes an assistant, and with delete_threads cascades only its own threads", async () => {
    const { service, deps } = makeService();
    await service.create({ graph_id: "echo", assistant_id: "a" });
    // Threads carry their run's assistant_id in metadata (as the run service stamps them).
    const mine = await deps.store.threads.create({ metadata: { assistant_id: "a" } });
    const other = await deps.store.threads.create({ metadata: { assistant_id: "b" } });

    await service.delete("a", { deleteThreads: true });

    expect(await deps.store.assistants.get("a")).toBeNull();
    expect(await deps.store.threads.get(mine.thread_id)).toBeNull();
    expect(await deps.store.threads.get(other.thread_id)).not.toBeNull();

    await expect(service.delete("ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("delete_threads scopes the cascade to the caller's own threads when auth is configured", async () => {
    const deps = createFixtureDeps({ auth: ownerScopedEngine("ada") });
    const ctx: ProtocolContext = {
      ...createContext(deps),
      authUser: { identity: "ada", display_name: "ada", is_authenticated: true, permissions: [] },
      authScopes: [],
    };
    const service = createAssistantService(ctx, createThreadService(ctx));
    await service.create({ graph_id: "echo", assistant_id: "a" });
    const mine = await ctx.deps.store.threads.create({
      metadata: { assistant_id: "a", owner: "ada" },
    });
    const theirs = await ctx.deps.store.threads.create({
      metadata: { assistant_id: "a", owner: "bob" },
    });

    await service.delete("a", { deleteThreads: true });

    // Only the caller's own thread is cascaded; another owner's thread on the same assistant survives.
    expect(await ctx.deps.store.threads.get(mine.thread_id)).toBeNull();
    expect(await ctx.deps.store.threads.get(theirs.thread_id)).not.toBeNull();
  });

  it("draws the graph and returns subgraph schemas", async () => {
    const { service } = makeService();
    await service.registerGraphAssistants();

    const graph = await service.drawGraph("echo");
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(graph.nodes.some((node) => node.id === "echo")).toBe(true);

    // The echo graph is flat — no subgraphs.
    expect(await service.subgraphs("echo")).toEqual({});
  });
});
