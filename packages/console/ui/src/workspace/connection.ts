const GENERATION_KEY = "skein-console:workspace-generation";
export const WORKSPACE_STORAGE_PREFIX = "skein-console:workspace:";

export function createWorkspaceGeneration(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("");
}

export function readWorkspaceGeneration(): string {
  try {
    const existing = localStorage.getItem(GENERATION_KEY);
    if (existing) return existing;
    const generation = createWorkspaceGeneration();
    localStorage.setItem(GENERATION_KEY, generation);
    return generation;
  } catch {
    return createWorkspaceGeneration();
  }
}

export function resolveWorkspaceConnection(apiUrl: string): string {
  let target: URL;
  try {
    target = new URL(apiUrl);
  } catch {
    return `invalid-target:${readWorkspaceGeneration()}`;
  }
  target.username = "";
  target.password = "";
  target.search = "";
  target.hash = "";
  return `${target.href.replace(/\/+$/, "")}:${readWorkspaceGeneration()}`;
}

/** Connection saves retire old drafts without deriving an identity from credentials. */
export function invalidateWorkspaceConnection(): void {
  try {
    localStorage.setItem(GENERATION_KEY, createWorkspaceGeneration());
  } catch {
    // Session storage may still be available when local storage is disabled.
  }
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(WORKSPACE_STORAGE_PREFIX)) sessionStorage.removeItem(key);
  } catch {
    // The provider reports storage failures; connection changes must remain usable.
  }
}

export function isConnectionStorageKey(key: string | null): boolean {
  return (
    key === null ||
    [
      GENERATION_KEY,
      "skein-console:baseUrl",
      "skein-console:apiKey",
      "skein-console:apiKeyFor",
    ].includes(key)
  );
}
