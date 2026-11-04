import { defineRegistry, JSONUIProvider, Renderer, useBoundProp } from "@json-render/react";
import { Client } from "@langchain/langgraph-sdk";
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";

import { catalog } from "../catalog.js";
import { addRunIdempotency } from "../plan-client.js";
import { createPlanSession } from "../plan-session.js";

export function App() {
  const [initialThreadId] = useState(() =>
    new URLSearchParams(window.location.search).get("thread"),
  );
  const [session] = useState(() =>
    createPlanSession(
      new Client<Record<string, unknown>>({
        apiUrl: window.location.origin + "/api",
        apiKey: null,
        defaultHeaders: { "x-user": "demo-user" },
        onRequest: addRunIdempotency,
      }),
    ),
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.read);
  const [prompt, setPrompt] = useState("Plan a small community workshop");
  const planRegistry = useMemo(
    () =>
      defineRegistry(catalog, {
        components: {
          Card: ({ props, children }) => (
            <article className="plan-card">
              <div className="eyebrow">A plan to build on</div>
              <h2>{props.title}</h2>
              {children}
            </article>
          ),
          Text: ({ props }) => <p className="plan-summary">{props.text}</p>,
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
                    placeholder="Try a smaller budget or a shorter timeline"
                  />
                  <button className="secondary" type="submit">
                    Revise plan
                  </button>
                </div>
              </form>
            );
          },
        },
        actions: {
          revisePlan: async (params) => {
            await session.generate(params);
          },
        },
      }),
    [session],
  );
  const handlers = useMemo(
    () =>
      planRegistry.handlers(
        () => undefined,
        () => ({}),
      ),
    [planRegistry],
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

  const canRevise = !snapshot.busy && !snapshot.review && !snapshot.preview;
  const renderable =
    snapshot.spec?.root && snapshot.spec.elements?.[snapshot.spec.root] ? snapshot.spec : null;
  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Plan builder home">
          <span className="brand-mark" aria-hidden="true">
            ↗
          </span>
          <span>Plan builder</span>
        </a>
        <span className="demo-label">Skein × json-render</span>
      </header>
      <main>
        <section className="intro">
          <div className="eyebrow">From an idea to a first step</div>
          <h1>
            Make room for
            <br />
            <span>your next idea.</span>
          </h1>
          <p>
            Describe something you want to do. Watch a plan take shape, refine it, then decide when
            it is ready.
          </p>
        </section>
        <div className="workspace">
          <aside className="request-panel">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void session.generate({ prompt });
              }}
            >
              <label htmlFor="request">What are you planning?</label>
              <textarea
                id="request"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                maxLength={2000}
                required
                rows={5}
                disabled={!canRevise}
              />
              <button className="primary" type="submit" disabled={!canRevise}>
                Build a plan <span aria-hidden="true">↗</span>
              </button>
            </form>
            <div className="session-tools">
              <button type="button" className="text-button" onClick={() => void session.open(null)}>
                New thread
              </button>
              {snapshot.threadId && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void session.open(snapshot.threadId)}
                >
                  Refresh thread
                </button>
              )}
            </div>
            <p className="small-note">
              The default demo runs offline. Each completed generation is saved in this thread.
              Review or reject it before requesting a revision.
            </p>
            {snapshot.threadId && (
              <a className="thread-link" href={"?thread=" + encodeURIComponent(snapshot.threadId)}>
                Reopen this thread <span aria-hidden="true">↗</span>
              </a>
            )}
          </aside>
          <section className="output-panel" aria-label="Generated plan" aria-busy={snapshot.busy}>
            <div className="output-toolbar">
              <span className="status" role="status">
                <span className={snapshot.busy ? "status-dot working" : "status-dot"} />
                {snapshot.busy
                  ? "Working on your plan…"
                  : snapshot.review
                    ? "Ready for your review"
                    : snapshot.ui
                      ? "Saved in this thread"
                      : "Your plan starts here"}
              </span>
              {snapshot.preview && <span className="preview-label">Preview</span>}
            </div>
            {snapshot.busy && snapshot.runId && (
              <div className="connection-tools">
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
            {snapshot.error && (
              <div className="notice error" role="alert">
                {snapshot.error}
              </div>
            )}
            {snapshot.recovery && (
              <div className="notice" role="status">
                {snapshot.recovery}
              </div>
            )}
            {renderable ? (
              <JSONUIProvider
                key={snapshot.ui?.generationId ?? snapshot.runId ?? "empty"}
                registry={planRegistry.registry}
                handlers={handlers}
                initialState={{ feedback: "" }}
                navigate={() => {
                  throw new Error("Navigation is not a plan action");
                }}
              >
                <fieldset className="generated-content" disabled={!canRevise}>
                  <legend className="sr-only">Generated plan and revision controls</legend>
                  <Renderer
                    spec={renderable}
                    registry={planRegistry.registry}
                    loading={snapshot.preview}
                  />
                </fieldset>
              </JSONUIProvider>
            ) : (
              <div className="empty-state">
                <span className="empty-illustration" aria-hidden="true">
                  ✳
                </span>
                <h2>A little structure goes a long way.</h2>
                <p>Your idea will become a plan here, one piece at a time.</p>
              </div>
            )}
            {snapshot.review && (
              <section className="review-panel" aria-label="Review plan">
                <div>
                  <h3>Does this feel like a good start?</h3>
                  <p>Approve this version, or reject it and try another direction.</p>
                </div>
                <div className="review-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void session.decide(false)}
                    disabled={snapshot.busy}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void session.decide(true)}
                    disabled={snapshot.busy}
                  >
                    Approve plan
                  </button>
                </div>
              </section>
            )}
            {snapshot.approved !== null && !snapshot.busy && (
              <div className="decision" role="status">
                {snapshot.approved
                  ? "Plan approved. You can keep refining it."
                  : "Plan rejected. Change your request or use the revision form."}
              </div>
            )}
          </section>
        </div>
      </main>
      <footer>
        Application-owned components. Streamed by your graph.{" "}
        <a href="https://skein.js.org/recipes/json-render">Read the integration recipe ↗</a>
      </footer>
    </div>
  );
}
