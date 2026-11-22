import type { Spec } from "@json-render/core";
import { Client } from "@langchain/langgraph-sdk";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { addRunIdempotency } from "../ui-client.js";
import { createUiSession } from "../ui-session.js";

import { GeneratedUi } from "./generated-ui.js";

const samples = [
  "Build a dashboard for skein-js/skein-js",
  "Show the GitHub profile for @octocat",
  "List recently pushed repositories for @torvalds",
] as const;

export function App() {
  const [initialThreadId] = useState(() =>
    new URLSearchParams(window.location.search).get("thread"),
  );

  const [session] = useState(() =>
    createUiSession(
      new Client<Record<string, unknown>>({
        apiUrl: window.location.origin + "/api",
        apiKey: null,
        defaultHeaders: { "x-user": "demo-user" },
        onRequest: addRunIdempotency,
      }),
    ),
  );

  const snapshot = useSyncExternalStore(session.subscribe, session.read);
  const generationId = snapshot.ui?.generationId;
  const conversation = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState(initialThreadId ? "" : samples[0]);
  useEffect(() => {
    void session.open(initialThreadId);

    return () => {
      session.dispose();
    };
  }, [session, initialThreadId]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (snapshot.threadId) url.searchParams.set("thread", snapshot.threadId);
    else url.searchParams.delete("thread");
    window.history.replaceState(null, "", url);
  }, [snapshot.threadId]);

  useEffect(() => {
    const element = conversation.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [snapshot.conversation.length, snapshot.pendingPrompt, snapshot.busy]);
  const canRevise =
    !snapshot.busy &&
    !snapshot.review &&
    !snapshot.preview &&
    !snapshot.needsRefresh &&
    snapshot.approved !== null;

  const renderable =
    snapshot.spec?.root && snapshot.spec.elements?.[snapshot.spec.root] ? snapshot.spec : null;

  const canSend = !snapshot.busy && !snapshot.review && !snapshot.needsRefresh;

  function send(nextPrompt = prompt) {
    const state = session.read();
    if (state.busy || state.review || state.needsRefresh) return;
    const draft = prompt;
    void session.generate({ prompt: nextPrompt }, () => {
      if (draft.trim() === nextPrompt.trim())
        setPrompt((current) => (current === draft ? "" : current));
    });
  }

  function renderUi(spec: Spec, key: string, disabled: boolean, loading = false) {
    return (
      <fieldset key={key} className="generated" disabled={disabled}>
        <legend className="sr-only">Generated interface and revision controls</legend>
        <GeneratedUi
          spec={spec}
          state={{ feedback: "" }}
          loading={loading}
          onAction={
            key === generationId
              ? (action, params) => {
                  if (action === "reviseUi") void session.revise(key, params);
                }
              : undefined
          }
        />
      </fieldset>
    );
  }

  return (
    <div className="playground">
      <header className="site-header">
        <a className="wordmark" href="/">
          ↗ <span>Skein playground</span>
        </a>
        <span className="platform">json-render · React</span>
        <nav aria-label="Playground controls">
          <a href="https://skein.js.org/recipes/json-render">Guide ↗</a>
          <button
            type="button"
            disabled={!snapshot.threadId}
            onClick={() => void session.open(snapshot.threadId)}
          >
            Refresh chat
          </button>
          <button
            type="button"
            onClick={() => {
              setPrompt("");
              void session.open(null);
            }}
          >
            New chat
          </button>
        </nav>
      </header>
      <div className="workspace">
        <main className="chat-panel" aria-label="UI conversation">
          <div className="conversation" ref={conversation}>
            {!snapshot.conversation.length && !snapshot.pendingPrompt && (
              <section className="welcome">
                <h1>Explore public GitHub data</h1>
                <p>Enter a username or repository to generate a view you can refine.</p>
                <div className="samples" aria-label="Sample prompts">
                  {samples.map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => send(sample)}
                      disabled={!canSend}
                    >
                      {sample} ↗
                    </button>
                  ))}
                </div>
              </section>
            )}
            {snapshot.conversation.map((turn) => (
              <div key={turn.generationId} className="turn">
                <p className="user-message">{turn.prompt}</p>
                {turn.ui &&
                (turn.generationId !== snapshot.ui?.generationId || snapshot.pendingPrompt) ? (
                  <article
                    className="assistant-message history-response"
                    aria-label="Earlier generated UI"
                  >
                    <div className="response-header">Saved version · read-only</div>
                    {renderUi(turn.ui.spec, turn.generationId, true)}
                  </article>
                ) : (
                  turn.generationId !== snapshot.ui?.generationId && (
                    <p className="earlier-response">This earlier response has no saved UI.</p>
                  )
                )}
              </div>
            ))}
            {snapshot.pendingPrompt && <p className="user-message">{snapshot.pendingPrompt}</p>}
            {snapshot.error && (
              <p className="notice error" role="alert">
                {snapshot.error}
              </p>
            )}
            {snapshot.recovery && (
              <p className="notice" role="status">
                {snapshot.recovery}
              </p>
            )}
            {(snapshot.busy || renderable) && (
              <article className="assistant-message current-response">
                <div className="response-header" role="status">
                  <span className="assistant-mark" aria-hidden="true">
                    ↗
                  </span>
                  <span>
                    {snapshot.preview
                      ? "Preview · saving after validation"
                      : snapshot.busy
                        ? "Looking up GitHub data and generating UI…"
                        : "Saved in this chat"}
                  </span>
                </div>
                {renderable &&
                  (!snapshot.pendingPrompt || snapshot.preview) &&
                  renderUi(
                    renderable,
                    snapshot.pendingPrompt
                      ? (snapshot.runId ?? "starting")
                      : (snapshot.ui?.generationId ?? "empty"),
                    !canRevise,
                    snapshot.preview,
                  )}
                {snapshot.review && !snapshot.busy && !snapshot.needsRefresh && (
                  <section className="review" aria-label="Review generated UI">
                    <div>
                      <strong>Keep this version?</strong>
                      <p>Review the saved UI to enable its controls and continue chatting.</p>
                    </div>
                    <div className="button-row">
                      <button type="button" onClick={() => void session.decide(false)}>
                        Reject
                      </button>
                      <button
                        className="primary"
                        type="button"
                        onClick={() => void session.decide(true)}
                      >
                        Approve UI
                      </button>
                    </div>
                  </section>
                )}
                {snapshot.approved !== null && !snapshot.busy && (
                  <p className="decision" role="status">
                    {snapshot.approved
                      ? "UI approved. Keep refining it."
                      : "UI rejected. Describe another direction."}
                  </p>
                )}
              </article>
            )}
          </div>
          <div className="composer-dock">
            {snapshot.busy && snapshot.runId && (
              <div className="run-tools">
                {snapshot.connected ? (
                  <button type="button" onClick={() => session.disconnect()}>
                    Pause updates
                  </button>
                ) : (
                  <button type="button" onClick={() => void session.reconnect()}>
                    Reconnect
                  </button>
                )}
                <button type="button" onClick={() => void session.stop()}>
                  Stop run
                </button>
              </div>
            )}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <label className="sr-only" htmlFor="ui-prompt">
                Describe the UI
              </label>
              <textarea
                id="ui-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                maxLength={2000}
                required
                rows={2}
                placeholder="Ask about a GitHub username or owner/repo…"
              />
              <div className="composer-footer">
                <button className="primary" type="submit" disabled={!canSend || !prompt.trim()}>
                  Send ↑
                </button>
              </div>
            </form>
            <div className="composer-note">
              <span>Approval records a decision. Nothing is published or submitted.</span>
              {snapshot.threadId && (
                <a href={"?thread=" + encodeURIComponent(snapshot.threadId)}>Reopen this chat ↗</a>
              )}
            </div>
          </div>
        </main>
        <aside className="inspector" aria-label="Generated JSON">
          <details open>
            <summary>
              Generated JSON <span>json-render</span>
            </summary>
            <p>
              Validated specification for the current {snapshot.preview ? "preview" : "saved UI"}.
              Read-only.
            </p>
            <pre role="region" tabIndex={0} aria-label="UI JSON">
              <code>{JSON.stringify(snapshot.spec ?? {}, null, 2)}</code>
            </pre>
          </details>
        </aside>
      </div>
    </div>
  );
}
