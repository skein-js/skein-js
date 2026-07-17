"use client";

import { useStream } from "@langchain/langgraph-sdk/react";
import { useState } from "react";

// Full-stack, single origin: the UI talks to the Agent Protocol served by this same app's
// `app/api/[...path]/route.ts`, so `apiUrl` is just the relative `/api` — no CORS, no second server.
// Defaults to the zero-setup `echo` graph; set NEXT_PUBLIC_SKEIN_ASSISTANT_ID=agent (with an
// ANTHROPIC_API_KEY) to talk to the Claude ReAct agent instead.

/** Flatten a message's `content` to display text (models may return string | parts | null). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : ((part as { text?: string }).text ?? "")))
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function speakerFor(type: string): { label: string; color: string } {
  if (type === "human") return { label: "you", color: "#7aa2f7" };
  if (type === "tool") return { label: "tool", color: "#e0af68" };
  return { label: "agent", color: "#9ece6a" };
}

export default function Page() {
  const assistantId = process.env.NEXT_PUBLIC_SKEIN_ASSISTANT_ID ?? "echo";
  const [input, setInput] = useState("");

  // Same-origin: this app serves the protocol under /api.
  const thread = useStream({ apiUrl: "/api", assistantId });

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>skein-js · Next.js (same-origin)</h1>
      <p style={{ color: "#9a9aa2", fontSize: 13, marginTop: 0 }}>
        /api · assistant <code>{assistantId}</code>
      </p>
      <p style={{ color: "#6b6b73", fontSize: 12, marginTop: -4 }}>
        {thread.messages.length} message(s) · {thread.isLoading ? "streaming…" : "idle"}
        {thread.error ? ` · error: ${String((thread.error as Error).message ?? thread.error)}` : ""}
      </p>

      <div
        style={{
          border: "1px solid #26262e",
          borderRadius: 10,
          padding: 12,
          minHeight: 240,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {thread.messages.length === 0 && (
          <span style={{ color: "#6b6b73", fontSize: 14 }}>No messages yet.</span>
        )}
        {thread.messages
          .map((m, i) => ({ m, i, text: messageText(m.content) }))
          .filter(({ m, text }) => text !== "" || m.type === "human")
          .map(({ m, i, text }) => {
            const isHuman = m.type === "human";
            const speaker = speakerFor(m.type);
            return (
              <div
                key={`${m.id ?? "msg"}-${i}`}
                style={{ display: "flex", justifyContent: isHuman ? "flex-end" : "flex-start" }}
              >
                <div style={{ maxWidth: "80%" }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: speaker.color,
                      marginBottom: 3,
                      textAlign: isHuman ? "right" : "left",
                    }}
                  >
                    {speaker.label}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.45,
                      padding: "8px 12px",
                      borderRadius: 12,
                      background: isHuman ? "#1d2740" : "#17211a",
                      border: `1px solid ${isHuman ? "#2b3a5e" : "#243a29"}`,
                      color: "#e7e7ea",
                    }}
                  >
                    {text || <span style={{ color: "#6b6b73" }}>…</span>}
                  </div>
                </div>
              </div>
            );
          })}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          thread.submit({ messages: [{ type: "human", content: input }] });
          setInput("");
        }}
        style={{ display: "flex", gap: 8, marginTop: 12 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say something…"
          style={{
            flex: 1,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid #26262e",
            background: "#111116",
            color: "#e7e7ea",
          }}
        />
        <button
          type="submit"
          disabled={thread.isLoading}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "none",
            background: thread.isLoading ? "#2a2a33" : "#7aa2f7",
            color: thread.isLoading ? "#8a8a92" : "#0b0b0f",
            fontWeight: 600,
            cursor: thread.isLoading ? "default" : "pointer",
          }}
        >
          {thread.isLoading ? "…" : "Send"}
        </button>
      </form>
    </main>
  );
}
