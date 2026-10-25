"use client";

import { useStream } from "@langchain/react";
import { useState } from "react";

/**
 * Minimal `useStream` harness.
 *
 * Point NEXT_PUBLIC_SKEIN_URL at a running skein-js server (default matches `skein dev`,
 * e.g. http://localhost:2024) and NEXT_PUBLIC_SKEIN_ASSISTANT_ID at a graph id from your
 * langgraph.json. This is the front-end signal that skein-js's SSE wiring satisfies the
 * LangChain React SDK. See ../../docs/react-sdk.md.
 */

/**
 * Flatten a message's `content` to display text. Chat models don't all return plain strings:
 * Gemini (and other multimodal models) return an array of content parts (`{ type, text }`), and a
 * ReAct tool-call turn carries no text at all (returns ""). Any other object shape is shown as JSON
 * rather than silently dropped, so nothing disappears from the transcript unexpectedly.
 */
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

/** Speaker label + accent color for a message role. Tool turns are distinct from the agent's. */
function speakerFor(type: string): { label: string; color: string } {
  if (type === "human") return { label: "you", color: "#7aa2f7" };
  if (type === "tool") return { label: "tool", color: "#e0af68" };
  return { label: "agent", color: "#9ece6a" };
}
export default function Page() {
  const apiUrl = process.env.NEXT_PUBLIC_SKEIN_URL ?? "http://localhost:2024";
  const assistantId = process.env.NEXT_PUBLIC_SKEIN_ASSISTANT_ID ?? "gemini";
  const [input, setInput] = useState("");

  const thread = useStream({ apiUrl, assistantId });

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>skein-js · useStream harness</h1>
      <p style={{ color: "#9a9aa2", fontSize: 13, marginTop: 0 }}>
        {apiUrl} · assistant <code>{assistantId}</code>
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
          // A conversation, not a raw dump: keep the turns that carry text (the human prompt and
          // the agent's replies) and drop the empty ReAct tool-call turns.
          .map((m, i) => ({ m, i, text: messageText(m.content) }))
          .filter(({ m, text }) => text !== "" || m.type === "human")
          .map(({ m, i, text }) => {
            const isHuman = m.type === "human";
            const speaker = speakerFor(m.type);
            return (
              // Index-qualified key: while streaming, useStream can briefly surface messages whose
              // `id` isn't yet unique (e.g. the optimistic human turn), so key on id-and-position.
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
          thread.submit({ messages: [{ role: "user", content: input }] });
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
