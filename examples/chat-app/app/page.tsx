"use client";

import { useStream } from "@langchain/react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";

import { ApprovalCard } from "@/components/approval-card";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { ThinkingBlock } from "@/components/thinking-block";
import { ToolCallCard } from "@/components/tool-call-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type ChatSummary, loadChats, upsertChat } from "@/lib/history";
import { answerText, roleOf, thinkingText, toolCalls, toolResultsByCall } from "@/lib/messages";
import { parseApproval } from "@/lib/tool-results";

const API_URL = process.env["NEXT_PUBLIC_SKEIN_URL"] ?? "http://localhost:2024";
const ASSISTANT_ID = process.env["NEXT_PUBLIC_SKEIN_ASSISTANT_ID"] ?? "research";
// Sent as the `X-Api-Key` header. Only enforced when the server sets `SKEIN_API_KEY` (see src/auth.ts);
// left undefined for the open local demo.
const API_KEY = process.env["NEXT_PUBLIC_SKEIN_API_KEY"];

const EXAMPLE_PROMPTS = [
  "Plan a trip to Tokyo — check the weather and find flights from San Francisco.",
  "Remember that I fly out of SFO and prefer window seats.",
  "Book the cheapest morning flight.",
];

export default function Page() {
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // The first message of a brand-new chat, remembered until its thread id arrives (→ becomes the title).
  const pendingTitle = useRef<string | null>(null);
  // True only while we're waiting for a just-started new chat's thread id. Navigating away (New chat
  // / selecting another chat) clears it, so a late onThreadId can't yank the user back.
  const awaitingNewThread = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore the conversation list after hydration (localStorage isn't available during SSR).
  useEffect(() => {
    setChats(loadChats());
  }, []);

  const thread = useStream({
    apiUrl: API_URL,
    apiKey: API_KEY,
    assistantId: ASSISTANT_ID,
    threadId,
    onThreadId: (id) => {
      if (!awaitingNewThread.current) return; // user navigated away before the thread was created
      awaitingNewThread.current = false;
      const title = pendingTitle.current ?? "New chat";
      pendingTitle.current = null;
      setThreadId(id);
      setChats((prev) => upsertChat(prev, id, title, Date.now()));
    },
  });

  const messages = thread.messages;
  // Tool results are separate `tool` messages; pair them to their calls so each card shows its output.
  const toolResults = toolResultsByCall(messages);
  // When `book_flight` calls `interrupt()`, the run pauses and skein surfaces the approval payload here.
  const approval = thread.interrupt ? parseApproval(thread.interrupt.value) : null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thread.isLoading) return;
    if (threadId) {
      setChats((prev) => upsertChat(prev, threadId, trimmed, Date.now())); // bump recency
    } else {
      pendingTitle.current = trimmed; // titles the thread once onThreadId fires
      awaitingNewThread.current = true;
    }
    thread.submit({ messages: [{ role: "user", content: trimmed }] });
    setInput("");
  }

  // Resume the pending interrupt with the user's decision through the SDK's input.respond command.
  function resolveApproval(approved: boolean) {
    void thread.respond({ approved });
  }

  // Leave the current conversation. Stop any in-flight run first so it doesn't keep streaming into a
  // thread the user can no longer see or stop.
  function leaveCurrentThread() {
    if (thread.isLoading) thread.stop();
    awaitingNewThread.current = false;
    pendingTitle.current = null;
  }

  function newChat() {
    leaveCurrentThread();
    setThreadId(null);
    setInput("");
  }

  function selectChat(id: string) {
    if (id === threadId) return;
    leaveCurrentThread();
    setThreadId(id);
  }

  return (
    <div className="flex h-screen">
      <Sidebar
        chats={chats}
        currentThreadId={threadId ?? null}
        onNewChat={newChat}
        onSelectChat={selectChat}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h1 className="text-sm font-semibold">skein-js · research &amp; trip assistant</h1>
            <p className="text-xs text-muted-foreground">
              {API_URL} · <code>{ASSISTANT_ID}</code>
            </p>
          </div>
          <ThemeToggle />
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
            {messages.length === 0 && (
              <div className="mx-auto max-w-lg space-y-4 pt-10 text-center">
                <h2 className="text-lg font-medium">What can I help you plan?</h2>
                <p className="text-sm text-muted-foreground">
                  A Gemini agent that thinks out loud, searches the web, pulls live-style data into
                  rich cards, remembers what you tell it across conversations, and asks before it
                  books anything.
                </p>
                <div className="flex flex-col gap-2">
                  {EXAMPLE_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => send(prompt)}
                      className="rounded-lg border px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message, index) => {
              const role = roleOf(message);
              // The SDK assigns IDs to optimistic messages and preserves them in server echoes.
              const key = message.id ?? `msg-${index}`;

              if (role === "human") {
                return (
                  <div key={key} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
                      {answerText(message.content)}
                    </div>
                  </div>
                );
              }

              // Only human and assistant turns are shown; tool results are folded into the cards, and
              // system/remove messages aren't part of the visible transcript.
              if (role !== "ai") return null;

              const thinking = thinkingText(message.content);
              const answer = answerText(message.content);
              const calls = toolCalls(message);
              return (
                <div key={key} className="flex flex-col gap-2" data-testid="assistant-message">
                  {thinking && <ThinkingBlock thinking={thinking} />}
                  {calls.map((call, callIndex) => (
                    <ToolCallCard
                      key={call.id ?? `${index}-${callIndex}`}
                      call={call}
                      result={toolResults.get(`${index}-${callIndex}`)}
                    />
                  ))}
                  {answer && (
                    <div className="prose-chat max-w-none text-sm">
                      <Markdown>{answer}</Markdown>
                    </div>
                  )}
                </div>
              );
            })}

            {approval && (
              <ApprovalCard
                request={approval}
                disabled={thread.isLoading}
                onDecision={resolveApproval}
              />
            )}

            {thread.isLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                <span>Working…</span>
              </div>
            )}

            {thread.error != null && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {String((thread.error as Error).message ?? thread.error)}
              </div>
            )}
          </div>
        </div>

        <form
          className="border-t px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            send(input);
          }}
        >
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
            <Textarea
              data-testid="composer-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // `isComposing` guards IME input: Enter that confirms a composition candidate
                // (Chinese/Japanese/Korean, etc.) must not submit the half-composed text.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send(input);
                }
              }}
              placeholder="Ask the research assistant…"
              rows={1}
            />
            {thread.isLoading ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={() => thread.stop()}
                aria-label="Stop"
              >
                <Square />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                data-testid="send-button"
                disabled={!input.trim()}
                aria-label="Send"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
