import type { Client } from "@langchain/langgraph-sdk";

import type { MeetingRecap } from "./meeting-notes.js";

/** An optional developer view of the same SDK calls the application actually makes. */
export function mountProtocolActivity(
  client: Client<MeetingRecap, Partial<MeetingRecap>>,
  root: HTMLElement,
  onBranch: (checkpointId: string) => Promise<void>,
) {
  root.innerHTML = `<summary>Inside this workflow <span>Agent Protocol activity</span></summary>
    <div class="protocol-content">
      <p>The desktop bridge supplies a connection. Every action below uses the LangGraph SDK and the same HTTP/SSE Agent Protocol a server app would use.</p>
      <div class="protocol-capabilities"><span>Persistent threads</span><span>Background runs</span><span>Live SSE</span><span>Interrupt & resume</span><span>Checkpoint branches</span><span>Shared store</span></div>
      <p class="section-label">CURRENT THREAD</p><code id="protocol-thread">Prepare or open a document to inspect it.</code>
      <div class="protocol-columns"><section><p class="section-label">RUN HISTORY</p><ol id="run-history"></ol></section>
        <section><p class="section-label">SAVED VERSIONS</p><p id="checkpoint-count">No document selected.</p>
          <div id="branch-controls" hidden><label for="checkpoint-choice">Start an alternative from an earlier draft</label><select id="checkpoint-choice"></select><button id="branch-draft" class="secondary-button">Branch from this draft</button><p class="input-hint">The original document and its saved file stay in your history. The branch gets its own thread and review.</p></div></section></div>
      <p class="section-label">LIVE PROTOCOL REQUESTS</p><p class="input-hint">Method and path only. Credentials and note contents are omitted.</p><ol id="protocol-requests" class="protocol-requests"></ol>
    </div>`;
  const select = <ElementType extends HTMLElement>(selector: string) =>
    root.querySelector<ElementType>(selector)!;
  const requests = select<HTMLOListElement>("#protocol-requests");
  select<HTMLButtonElement>("#branch-draft").onclick = () => {
    void onBranch(select<HTMLSelectElement>("#checkpoint-choice").value);
  };
  return {
    recordRequest(url: URL, init: RequestInit) {
      const item = document.createElement("li");
      item.textContent = `${init.method ?? "GET"} ${url.pathname}`;
      requests.prepend(item);
      if (requests.children.length > 60) requests.lastElementChild?.remove();
    },
    clear() {
      select<HTMLElement>("#protocol-thread").textContent =
        "Prepare or open a document to inspect it.";
      select<HTMLElement>("#run-history").replaceChildren();
      select<HTMLElement>("#checkpoint-count").textContent = "No document selected.";
      select<HTMLElement>("#branch-controls").hidden = true;
    },
    async refresh(threadId: string) {
      select<HTMLElement>("#protocol-thread").textContent = threadId;
      const [runs, checkpoints] = await Promise.all([
        client.runs.list(threadId, { limit: 30 }),
        client.threads.getHistory(threadId, { limit: 50 }),
      ]);
      const list = select<HTMLOListElement>("#run-history");
      list.replaceChildren();
      for (const run of [...runs].reverse()) {
        const item = document.createElement("li");
        const label = run.metadata?.["demo_action"] ?? "Workflow run";
        item.textContent = `${label} · ${run.status} · ${new Date(run.created_at).toLocaleTimeString()}`;
        list.append(item);
      }
      select<HTMLElement>("#checkpoint-count").textContent =
        `${checkpoints.length} persisted checkpoints. Select an earlier review to explore another outcome.`;
      const drafts = checkpoints.filter(
        (checkpoint) =>
          checkpoint.next.includes("approve") && checkpoint.values.outcome === "review",
      );
      const choices = select<HTMLSelectElement>("#checkpoint-choice");
      choices.replaceChildren();
      for (const [index, checkpoint] of drafts.entries()) {
        const option = document.createElement("option");
        option.value = checkpoint.checkpoint.checkpoint_id!;
        option.textContent = `Review draft ${drafts.length - index} · ${checkpoint.values.actions.length} follow-ups`;
        choices.append(option);
      }
      select<HTMLElement>("#branch-controls").hidden = drafts.length === 0;
    },
  };
}
