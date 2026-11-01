import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";

import { resolveApiUrl } from "@/api";

import {
  createWorkspaceGeneration,
  isConnectionStorageKey,
  resolveWorkspaceConnection,
} from "./connection";
import { createWorkspaceStore, type WorkspaceStore } from "./store";

const WorkspaceContext = createContext<WorkspaceStore | undefined>(undefined);
const StorageFailureContext = createContext(false);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [binding, setBinding] = useState(() => ({
    connection: resolveWorkspaceConnection(resolveApiUrl()),
    revision: createWorkspaceGeneration(),
  }));
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (!isConnectionStorageKey(event.key)) return;
      // Retire this tab's snapshot too; sessionStorage is not shared between tabs.
      try {
        for (const key of Object.keys(sessionStorage))
          if (key.startsWith("skein-console:workspace:")) sessionStorage.removeItem(key);
      } catch {
        /* The new provider reports persistence availability. */
      }
      setBinding({
        connection: resolveWorkspaceConnection(resolveApiUrl()),
        revision: createWorkspaceGeneration(),
      });
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return (
    <ConnectionWorkspace key={binding.revision} connection={binding.connection}>
      {children}
    </ConnectionWorkspace>
  );
}

function ConnectionWorkspace({
  connection,
  children,
}: {
  connection: string;
  children: ReactNode;
}) {
  const [storageFailed, setStorageFailed] = useState(false);
  const [store] = useState(() => createWorkspaceStore(connection, () => setStorageFailed(true)));
  const [ready, setReady] = useState(false);
  const hydration = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    hydration.current ??= Promise.resolve(store.persist.rehydrate());
    let mounted = true;
    void hydration.current.finally(() => {
      if (mounted) setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, [store]);
  return (
    <WorkspaceContext.Provider value={store}>
      <StorageFailureContext.Provider value={storageFailed}>
        {ready ? (
          children
        ) : (
          <p role="status" className="p-6">
            Restoring workspace…
          </p>
        )}
      </StorageFailureContext.Provider>
    </WorkspaceContext.Provider>
  );
}

export function WorkspaceStorageNotice() {
  return useContext(StorageFailureContext) ? (
    <p role="status" className="mt-2 text-xs text-status-error">
      Browser storage is unavailable or invalid. Drafts are kept in memory and may not survive a
      reload.
    </p>
  ) : null;
}

export function useWorkspaceStore(): WorkspaceStore | undefined {
  return useContext(WorkspaceContext);
}

/** Optional outside the shell so isolated resource views remain independently renderable. */
export function useWorkspace<T>(
  selector: (state: ReturnType<WorkspaceStore["getState"]> | undefined) => T,
): T {
  const store = useWorkspaceStore();
  return useStore(store ?? EMPTY_STORE, selector);
}

const EMPTY_STORE = {
  getState: () => undefined,
  getInitialState: () => undefined,
  subscribe: () => () => {},
};
