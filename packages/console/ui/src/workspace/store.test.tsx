import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceProvider, useWorkspace, useWorkspaceStore } from "./provider";
import { getThreadInspectionTab, parseWorkspaceSnapshot } from "./snapshot";
import { createWorkspaceStore, createDraftKey, type WorkspaceStore } from "./store";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe("workspace persistence", () => {
  it("ignores inherited properties while preserving explicit custom thread tabs", () => {
    const snapshot = parseWorkspaceSnapshot({ threadTabs: { constructor: "state" } });
    expect(getThreadInspectionTab({}, "constructor")).toBeUndefined();
    expect(getThreadInspectionTab(snapshot.threadTabs, "constructor")).toBe("state");
    expect(getThreadInspectionTab(snapshot.threadTabs, "toString")).toBeUndefined();
    expect(getThreadInspectionTab(snapshot.threadTabs, "__proto__")).toBeUndefined();
  });

  it("restores independent drafts, intentional empty input and actual capped page offsets without persisting actions", async () => {
    const store = createWorkspaceStore("server/api:generation", vi.fn());
    await store.persist.rehydrate();
    const first = createDraftKey("thread-1", "assistant-1");
    store.getState().updateDraft(first, { chat: "Keep this", json: "", mode: "json" });
    store
      .getState()
      .updateDraft(createDraftKey("thread-2", "assistant-1"), { chat: "Other thread" });
    store
      .getState()
      .updateDraft(createDraftKey("thread-1", "assistant-2"), { chat: "Other assistant" });
    store
      .getState()
      .rememberPage("threads:all", { queryKey: "all", pageSize: 50, offsets: [0, 3, 6] });
    const saved = sessionStorage.getItem(store.persist.getOptions().name)!;
    expect(saved).not.toContain("updateDraft");
    expect(saved).not.toContain("rememberPage");
    const restored = createWorkspaceStore("server/api:generation", vi.fn());
    await restored.persist.rehydrate();
    expect(restored.getState().drafts[first]).toEqual({
      chat: "Keep this",
      json: "",
      mode: "json",
    });
    expect(Object.keys(restored.getState().drafts)).toHaveLength(3);
    expect(restored.getState().pages["threads:all"]?.offsets).toEqual([0, 3, 6]);
    const otherConnection = createWorkspaceStore("server/other:generation", vi.fn());
    await otherConnection.persist.rehydrate();
    expect(otherConnection.getState().drafts).toEqual({});
  });

  it("moves a fresh draft to its created thread, clears only unchanged submissions, and forgets deleted threads", () => {
    const store = createWorkspaceStore("transfer", vi.fn());
    const fresh = createDraftKey(undefined, "assistant");
    const existing = createDraftKey("thread", "assistant");
    store.getState().updateDraft(fresh, { chat: "Submitted", json: "{}" });
    store.getState().moveDraft(fresh, existing);
    expect(store.getState().drafts[fresh]).toBeUndefined();
    store.getState().updateDraft(existing, { chat: "Newer draft" });
    store.getState().clearSubmittedDraft(existing, "chat", "Submitted");
    expect(store.getState().drafts[existing]?.chat).toBe("Newer draft");
    store.getState().clearSubmittedDraft(existing, "chat", "Newer draft");
    expect(store.getState().drafts[existing]?.chat).toBe("");
    store.getState().rememberWorkspace({ threadId: "thread", assistantId: "assistant" });
    store.getState().forgetThread("thread");
    expect(store.getState().drafts).toEqual({});
    expect(store.getState().lastWorkspace).toBeUndefined();
  });

  it.each(["getItem", "setItem", "removeItem"] as const)(
    "keeps memory usable when %s fails",
    async (method) => {
      const failure = vi.fn();
      const storage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      };
      storage[method] = () => {
        throw new Error("Storage denied");
      };
      const store = createWorkspaceStore(method, failure, () => storage);
      await store.persist.rehydrate();
      expect(() => store.getState().updateDraft("draft", { chat: "Still here" })).not.toThrow();
      expect(() => store.persist.clearStorage()).not.toThrow();
      expect(store.getState().drafts.draft?.chat).toBe("Still here");
      expect(failure).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects corrupted/version-mismatched state and prevents saved fields replacing actions", async () => {
    const failure = vi.fn();
    const store = createWorkspaceStore("invalid", failure);
    const name = store.persist.getOptions().name;
    sessionStorage.setItem(name, "{");
    await store.persist.rehydrate();
    expect(failure).toHaveBeenCalled();
    sessionStorage.setItem(
      name,
      JSON.stringify({ version: 999, state: { drafts: { bad: { chat: "Wrong version" } } } }),
    );
    await store.persist.rehydrate();
    expect(store.getState().drafts).toEqual({});
    sessionStorage.setItem(
      name,
      JSON.stringify({
        version: 1,
        state: {
          updateDraft: "replace action",
          pages: { bad: { pageSize: 50, queryKey: "all", offsets: [0, -3] } },
          drafts: { draft: { chat: 123, json: "" } },
          threadListRoute: "playground/other",
        },
      }),
    );
    await store.persist.rehydrate();
    expect(typeof store.getState().updateDraft).toBe("function");
    expect(store.getState().pages).toEqual({});
    expect(store.getState().drafts.draft).toEqual({ json: "" });
    expect(store.getState().threadListRoute).toBe("threads");
  });
});

it("hydrates before mounting editors under StrictMode and keeps selector subscribers isolated", async () => {
  let activeStore: ReturnType<typeof useWorkspaceStore>;
  let renders = 0;
  function Editor() {
    activeStore = useWorkspaceStore();
    const draft = useWorkspace((state) => state?.drafts.editor?.chat ?? "");
    return <input aria-label="Restored draft" value={draft} readOnly />;
  }
  function Unrelated() {
    useWorkspace((state) => state?.lastWorkspace);
    renders++;
    return null;
  }
  const connection = `${location.origin}:${crypto.randomUUID()}`;
  localStorage.setItem("skein-console:workspace-generation", connection.split(":").at(-1)!);
  // The default jsdom mount resolves to the origin API root.
  const initial = createWorkspaceStore(
    `${location.origin}:${connection.split(":").at(-1)}`,
    vi.fn(),
  );
  initial.getState().updateDraft("editor", { chat: "Saved before mount" });
  render(
    <StrictMode>
      <WorkspaceProvider>
        <Editor />
        <Unrelated />
      </WorkspaceProvider>
    </StrictMode>,
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Restored draft") as HTMLInputElement).value).toBe(
      "Saved before mount",
    ),
  );
  const before = renders;
  act(() => activeStore?.getState().updateDraft("different", { chat: "Unrelated update" }));
  expect(renders).toBe(before);
});

it.each([
  ["First workspace", "Second workspace"],
  ["Second workspace", "First workspace"],
])("isolates provider memory under StrictMode (%s first)", async (firstLabel, secondLabel) => {
  const stores = new Map<string, WorkspaceStore>();
  function Editor({ label }: { label: string }) {
    const store = useWorkspaceStore();
    const draft = useWorkspace((state) => state?.drafts.editor?.chat ?? "");
    // Providers hydrate independently, so capture their identity rather than their render order.
    if (store) stores.set(label, store);
    return <input aria-label={label} value={draft} readOnly />;
  }
  render(
    <StrictMode>
      <WorkspaceProvider>
        <Editor label={firstLabel} />
      </WorkspaceProvider>
      <WorkspaceProvider>
        <Editor label={secondLabel} />
      </WorkspaceProvider>
    </StrictMode>,
  );
  await Promise.all([
    screen.findByLabelText("First workspace"),
    screen.findByLabelText("Second workspace"),
  ]);
  expect(stores.size).toBe(2);
  expect(stores.get("First workspace")).not.toBe(stores.get("Second workspace"));
  act(() =>
    stores
      .get("First workspace")!
      .getState()
      .updateDraft("editor", { chat: "Only the first provider" }),
  );
  expect((screen.getByLabelText("First workspace") as HTMLInputElement).value).toBe(
    "Only the first provider",
  );
  expect((screen.getByLabelText("Second workspace") as HTMLInputElement).value).toBe("");
});
