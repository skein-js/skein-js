// A tiny, client-side record of past conversations for the sidebar. Each Agent Protocol thread is
// one chat; we remember its id + a title (the first thing you asked) in localStorage so the list
// survives reloads. Selecting one re-opens that thread — its messages are loaded from the server by
// `useStream`, so this store only needs the id and a label, not the transcript.

export interface ChatSummary {
  threadId: string;
  title: string;
  updatedAt: number;
}

const STORAGE_KEY = "skein-chat-app.history";
const MAX_TITLE_LENGTH = 60;

/** Load the saved chats, most recently updated first. Safe to call before hydration (returns []). */
export function loadChats(): ChatSummary[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatSummary[];
    return [...parsed].sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Insert or update a chat (by threadId) and persist. Returns the new list, most recent first. */
export function upsertChat(
  chats: ChatSummary[],
  threadId: string,
  title: string,
  now: number,
): ChatSummary[] {
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH) || "New chat";
  const existing = chats.find((chat) => chat.threadId === threadId);

  const next = existing
    ? chats.map((chat) => (chat.threadId === threadId ? { ...chat, updatedAt: now } : chat))
    : [...chats, { threadId, title: trimmed, updatedAt: now }];

  const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
  persist(sorted);
  return sorted;
}

function persist(chats: ChatSummary[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  } catch {
    // localStorage can be unavailable (private mode / quota) — the list is a convenience, not state.
  }
}
