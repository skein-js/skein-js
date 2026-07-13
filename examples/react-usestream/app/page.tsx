"use client";

import { useStream } from "@langchain/langgraph-sdk/react";
import { useState } from "react";

/**
 * Minimal `useStream` harness.
 *
 * Point NEXT_PUBLIC_SKEIN_URL at a running skein-js server (default matches `skein dev`,
 * e.g. http://localhost:2024) and NEXT_PUBLIC_SKEIN_ASSISTANT_ID at a graph id from your
 * langgraph.json. This is the front-end signal that skein-js's SSE wiring satisfies the
 * LangChain React SDK. See ../../docs/react-sdk.md.
 */
export default function Page() {
  const apiUrl = process.env.NEXT_PUBLIC_SKEIN_URL ?? "http://localhost:2024";
  const assistantId = process.env.NEXT_PUBLIC_SKEIN_ASSISTANT_ID ?? "agent";
  const [input, setInput] = useState("");

  const thread = useStream({ apiUrl, assistantId });

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>skein-js · useStream harness</h1>
      <p style={{ color: "#9a9aa2", fontSize: 13, marginTop: 0 }}>
        {apiUrl} · assistant <code>{assistantId}</code>
      </p>

      <div
        style={{
          border: "1px solid #26262e",
          borderRadius: 10,
          padding: 12,
          minHeight: 240,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {thread.messages.length === 0 && (
          <span style={{ color: "#6b6b73", fontSize: 14 }}>No messages yet.</span>
        )}
        {thread.messages.map((m) => (
          <div key={m.id} style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>
            <strong style={{ color: m.type === "human" ? "#7aa2f7" : "#9ece6a" }}>
              {m.type === "human" ? "you" : "agent"}
            </strong>
            {"  "}
            {typeof m.content === "string" ? m.content : JSON.stringify(m.content)}
          </div>
        ))}
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
