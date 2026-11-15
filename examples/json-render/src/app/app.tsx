import { defineRegistry, JSONUIProvider, Renderer, useBoundProp } from "@json-render/react";
import { Client } from "@langchain/langgraph-sdk";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { catalog } from "../catalog.js";
import { addRunIdempotency } from "../ui-client.js";
import { createUiSession } from "../ui-session.js";

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
  const conversation = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState(initialThreadId ? "" : "Website traffic dashboard");
  const uiRegistry = useMemo(
    () =>
      defineRegistry(catalog, {
        components: {
          Card: ({ props, children }) => (
            <article className="ui-card">
              <h2>{props.title}</h2>
              {children}
            </article>
          ),
          Text: ({ props }) => <p className="plan-summary">{props.text}</p>,
          Grid: ({ props, children }) => (
            <div
              className="metric-grid"
              style={{ gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` }}
            >
              {children}
            </div>
          ),
          Metric: ({ props }) => (
            <section className="metric">
              <span>{props.label}</span>
              <strong>{props.value}</strong>
              <small>{props.detail}</small>
            </section>
          ),
          Table: ({ props }) => (
            <div className="table-scroll">
              <table>
                <caption>{props.caption}</caption>
                <thead>
                  <tr>
                    {props.columns.map((column, index) => (
                      <th key={index} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {props.rows.map((row, index) => (
                    <tr key={index}>
                      {row.map((cell, column) => (
                        <td key={column}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ),
          TaskList: ({ props }) => (
            <ol className="task-list">
              {(props.tasks ?? []).map((task, index) => (
                <li key={index}>
                  <span className="task-number">{String(index + 1).padStart(2, "0")}</span>
                  <span>{task}</span>
                </li>
              ))}
            </ol>
          ),
          Button: ({ props, emit }) => (
            <button className="secondary" type="button" onClick={() => emit("press")}>
              {props.label}
            </button>
          ),
          FeedbackForm: ({ props, bindings, emit }) => {
            const [value, setValue] = useBoundProp(props.value, bindings?.["value"]);
            const id = useId();
            return (
              <form
                className="feedback"
                onSubmit={(event) => {
                  event.preventDefault();
                  emit("submit");
                }}
              >
                <label htmlFor={id}>{props.label}</label>
                <div className="input-row">
                  <input
                    id={id}
                    value={value ?? ""}
                    maxLength={2000}
                    onChange={(event) => setValue(event.target.value)}
                    required
                    placeholder="Describe a change to the interface"
                  />
                  <button className="secondary" type="submit">
                    Update UI
                  </button>
                </div>
              </form>
            );
          },
        },
        actions: {
          reviseUi: async (params) => {
            await session.generate(params);
          },
        },
      }),
    [session],
  );
  const handlers = useMemo(
    () =>
      uiRegistry.handlers(
        () => undefined,
        () => ({}),
      ),
    [uiRegistry],
  );

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
    !snapshot.busy && !snapshot.review && !snapshot.preview && snapshot.approved !== null;
  const renderable =
    snapshot.spec?.root && snapshot.spec.elements?.[snapshot.spec.root] ? snapshot.spec : null;
  const canSend = !snapshot.busy && !snapshot.review;
  async function send(nextPrompt = prompt) {
    await session.generate({ prompt: nextPrompt });
    if (!session.read().error) setPrompt((current) => (current === nextPrompt ? "" : current));
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
                <span className="eyebrow">Your prompt. Your components.</span>
                <h1>Describe an interface.</h1>
                <p>
                  Dashboards, forms, comparison cards. Watch a UI take shape, then make it yours.
                </p>
                <div className="samples" aria-label="Sample prompts">
                  {[
                    "Website traffic dashboard",
                    "Event registration form",
                    "Product comparison cards",
                  ].map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => {
                        setPrompt(sample);
                        void send(sample);
                      }}
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
                {turn.generationId !== snapshot.ui?.generationId && (
                  <p className="earlier-response">
                    UI updated · the latest version is shown below.
                  </p>
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
              <article className="assistant-message">
                <div className="response-header" role="status">
                  <span className="assistant-mark" aria-hidden="true">
                    ↗
                  </span>
                  <span>
                    {snapshot.preview
                      ? "Preview · saving after validation"
                      : snapshot.busy
                        ? "Generating UI…"
                        : "Saved in this chat"}
                  </span>
                </div>
                {renderable && (
                  <JSONUIProvider
                    key={snapshot.ui?.generationId ?? snapshot.runId ?? "empty"}
                    registry={uiRegistry.registry}
                    handlers={handlers}
                    initialState={{ feedback: "" }}
                    navigate={() => {
                      throw new Error("Navigation is outside this playground");
                    }}
                  >
                    <fieldset className="generated" disabled={!canRevise}>
                      <legend className="sr-only">Generated interface and revision controls</legend>
                      <Renderer
                        spec={renderable}
                        registry={uiRegistry.registry}
                        loading={snapshot.preview}
                      />
                    </fieldset>
                  </JSONUIProvider>
                )}
                {snapshot.review && !snapshot.busy && (
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
                placeholder="Ask for a dashboard, form or product comparison…"
              />
              <div className="composer-footer">
                <span>Offline samples by default</span>
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
            <pre tabIndex={0} aria-label="UI JSON">
              <code>{JSON.stringify(snapshot.spec ?? {}, null, 2)}</code>
            </pre>
          </details>
        </aside>
      </div>
    </div>
  );
}
