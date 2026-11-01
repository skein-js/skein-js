import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

import { WORKSPACE_STORAGE_PREFIX } from "./connection";
import {
  createEmptyWorkspaceSnapshot,
  parseWorkspaceSnapshot,
  type InputMode,
  type PagePosition,
  type WorkspaceDraft,
  type WorkspaceSnapshot,
} from "./snapshot";

interface WorkspaceState extends WorkspaceSnapshot {
  updateDraft: (workspace: string, patch: WorkspaceDraft) => void;
  clearSubmittedDraft: (workspace: string, mode: InputMode, submitted: string) => void;
  moveDraft: (sourceKey: string, targetKey: string) => void;
  rememberWorkspace: (workspace: WorkspaceSnapshot["lastWorkspace"]) => void;
  rememberPage: (key: string, position: PagePosition) => void;
  rememberThreadList: (route: string) => void;
  rememberThreadTab: (threadId: string, tab: WorkspaceSnapshot["threadTabs"][string]) => void;
  rememberReturnRow: (threadId: string | undefined) => void;
  forgetThread: (threadId: string) => void;
}

export function createDraftKey(threadId: string | undefined, assistantId: string): string {
  return JSON.stringify([threadId ?? null, assistantId]);
}

export function createWorkspaceStore(
  connection: string,
  onStorageFailure: () => void,
  getStorage: () => Storage = () => sessionStorage,
) {
  // Reporting stays outside the persisted store, avoiding recursive writes on failure.
  const storage: StateStorage = {
    getItem: (key) => {
      try {
        return getStorage().getItem(key);
      } catch {
        onStorageFailure();
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        getStorage().setItem(key, value);
      } catch {
        onStorageFailure();
      }
    },
    removeItem: (key) => {
      try {
        getStorage().removeItem(key);
      } catch {
        onStorageFailure();
      }
    },
  };
  return createStore<WorkspaceState>()(
    persist(
      (set, get) => ({
        ...createEmptyWorkspaceSnapshot(),
        updateDraft: (key, patch) =>
          set((state) => ({
            drafts: { ...state.drafts, [key]: { ...state.drafts[key], ...patch } },
          })),
        clearSubmittedDraft: (key, mode, submitted) => {
          const { drafts } = get();
          // Calling persist's setter writes even when the returned state is unchanged.
          if ((drafts[key]?.[mode] ?? submitted) !== submitted) return;
          set({ drafts: { ...drafts, [key]: { ...drafts[key], [mode]: "" } } });
        },
        moveDraft: (sourceKey, targetKey) =>
          set((state) => {
            if (sourceKey === targetKey || !state.drafts[sourceKey]) return state;
            const drafts = { ...state.drafts, [targetKey]: state.drafts[sourceKey] };
            delete drafts[sourceKey];
            return { drafts };
          }),
        rememberWorkspace: (lastWorkspace) =>
          set((state) =>
            JSON.stringify(state.lastWorkspace) === JSON.stringify(lastWorkspace)
              ? state
              : { lastWorkspace },
          ),
        rememberPage: (key, position) =>
          set((state) => ({ pages: { ...state.pages, [key]: position } })),
        rememberThreadList: (threadListRoute) =>
          set((state) => (state.threadListRoute === threadListRoute ? state : { threadListRoute })),
        rememberThreadTab: (threadId, tab) =>
          set((state) =>
            state.threadTabs[threadId] === tab
              ? state
              : { threadTabs: { ...state.threadTabs, [threadId]: tab } },
          ),
        rememberReturnRow: (returnRow) => set({ returnRow }),
        forgetThread: (threadId) =>
          set((state) => {
            const drafts = Object.fromEntries(
              Object.entries(state.drafts).filter(([key]) => {
                try {
                  return JSON.parse(key)[0] !== threadId;
                } catch {
                  return false;
                }
              }),
            );
            const threadTabs = { ...state.threadTabs };
            delete threadTabs[threadId];
            return {
              drafts,
              threadTabs,
              pages: Object.fromEntries(
                Object.entries(state.pages).filter(
                  ([key]) => !key.startsWith(`thread-runs:${threadId}:`),
                ),
              ),
              ...(state.lastWorkspace?.threadId === threadId ? { lastWorkspace: undefined } : {}),
              ...(state.returnRow === threadId ? { returnRow: undefined } : {}),
            };
          }),
      }),
      {
        name: `${WORKSPACE_STORAGE_PREFIX}${connection}`,
        version: 1,
        storage: createJSONStorage(() => storage),
        skipHydration: true,
        partialize: ({ drafts, lastWorkspace, pages, threadListRoute, threadTabs, returnRow }) => ({
          drafts,
          lastWorkspace,
          pages,
          threadListRoute,
          threadTabs,
          returnRow,
        }),
        migrate: () => {
          onStorageFailure();
          return createEmptyWorkspaceSnapshot();
        },
        merge: (stored, current) => ({ ...current, ...parseWorkspaceSnapshot(stored) }),
        onRehydrateStorage: () => (_state, error) => {
          if (error) onStorageFailure();
        },
      },
    ),
  );
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
