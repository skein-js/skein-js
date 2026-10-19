import { Client, type Thread } from "@langchain/langgraph-sdk";

import {
  meetingMarkdown,
  sampleMeeting,
  type MeetingAction,
  type MeetingRecap,
} from "./meeting-notes.js";
import { mountModelSettings } from "./model-settings.js";
import { mountProtocolActivity } from "./protocol-activity.js";
import { sampleReading } from "./reading-sample.js";
import { icon, renderWorkspace } from "./workspace-view.js";

type StoredMessage = { type?: string; role?: string; content?: unknown; name?: string };
interface ChatState {
  messages?: StoredMessage[];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((block) =>
        typeof block === "object" && block && "text" in block ? String(block.text) : "",
      )
      .join("");
  return "";
}

export async function mountWorkflowUi(
  connection: { url: string; token: string },
  application: "meetings" | "reading" = "meetings",
): Promise<void> {
  const reading = application === "reading";
  const demoKind = reading ? "reading-room" : "meeting-follow-up";
  const archiveNamespace = reading ? "reading-briefs" : "meeting-recaps";
  renderWorkspace(document.querySelector<HTMLElement>("#app")!, application);
  const select = <ElementType extends HTMLElement>(selector: string) =>
    document.querySelector<ElementType>(selector)!;
  const client = new Client<MeetingRecap, Partial<MeetingRecap>>({
    apiUrl: connection.url,
    defaultHeaders: { authorization: `Bearer ${connection.token}` },
    onRequest(url, init) {
      activity.recordRequest(url, init);
      return init;
    },
  });
  const title = select<HTMLTextAreaElement>("#title");
  const notes = select<HTMLTextAreaElement>("#notes");
  const chat = select<HTMLElement>("#chat");
  const search = select<HTMLInputElement>("#recap-search");
  const errorNotice = select<HTMLElement>("#error");
  const activity = mountProtocolActivity(
    client,
    select<HTMLElement>("#protocol-activity"),
    branchDraft,
  );
  const modelSettings = mountModelSettings(connection, (status) => {
    select<HTMLElement>("#connection-label").textContent = status.configured
      ? `${status.providerLabel} ready`
      : "Connect model";
    select<HTMLElement>("#assistant-model-label").textContent = status.configured
      ? status.model
      : "Connect a model to get started";
    select<HTMLElement>("#connection-status").classList.toggle("connected", status.configured);
    select<HTMLElement>("#model-dot").classList.toggle("connected", status.configured);
  });
  let threadId: string | undefined;
  let assistantId: string | undefined;
  let recap: Partial<MeetingRecap> = {};
  let reviewing = false;
  let workBusy = false;
  let chatBusy = false;
  let loading = false;
  let selectedVersion = 0;
  let workStream: AbortController | undefined;
  let chatStream: AbortController | undefined;
  let draftSave: ReturnType<typeof setTimeout> | undefined;
  let draftWrite: Promise<void> = Promise.resolve();
  let metadataWrite: Promise<void> = Promise.resolve();
  async function updateMetadata(id: string, patch: Record<string, unknown>): Promise<void> {
    metadataWrite = metadataWrite
      .catch(() => undefined)
      .then(async () => {
        const current = await client.threads.get(id);
        await client.threads.update(id, { metadata: { ...current.metadata, ...patch } });
      });
    await metadataWrite;
  }
  let threads: Thread<MeetingRecap>[] = [];

  function showError(error: unknown): void {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.message.includes("aborted"))
    )
      return;
    errorNotice.textContent =
      error instanceof Error
        ? error.message
        : "Something went wrong. Your saved notes are still here.";
    errorNotice.hidden = false;
  }
  function setTab(tab: "notes" | "recap"): void {
    select<HTMLElement>("#notes-view").hidden = tab !== "notes";
    select<HTMLElement>("#recap-view").hidden = tab !== "recap";
    select<HTMLElement>("#notes-tab").setAttribute("aria-selected", String(tab === "notes"));
    select<HTMLElement>("#recap-tab").setAttribute("aria-selected", String(tab === "recap"));
  }
  function isStale(): boolean {
    return Boolean(recap.notes && recap.notes.trim() !== notes.value.trim());
  }
  function updateControls(): void {
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
    const hasRecap = Array.isArray(recap.actions);
    const canReview = reviewing && !isStale();
    select<HTMLButtonElement>("#start").disabled = workBusy || !notes.value.trim();
    select<HTMLButtonElement>("#start").innerHTML =
      `${workBusy ? '<span class="spinner"></span>' : icon("spark")}${workBusy ? "Preparing…" : hasRecap ? "Generate new recap" : "Generate recap"}`;
    select<HTMLElement>("#draft-controls").hidden =
      canReview || (!isStale() && recap.outcome === "saved");
    select<HTMLElement>("#review-controls").hidden = !canReview;
    select<HTMLElement>("#completed-controls").hidden = !hasRecap || canReview || isStale();
    select<HTMLButtonElement>("#approve").disabled = workBusy;
    select<HTMLButtonElement>("#dismiss").disabled = workBusy;
    select<HTMLButtonElement>("#download").hidden = recap.outcome !== "saved";
    select<HTMLElement>("#completion-label").textContent =
      recap.outcome === "saved" ? "Saved to your workspace" : "Draft dismissed";
    select<HTMLButtonElement>("#send-message").disabled = chatBusy || !threadId;
    select<HTMLElement>("#work-progress").hidden = !workBusy && !chatBusy;
    select<HTMLElement>("#meeting-status").textContent = workBusy
      ? reading
        ? "Preparing brief"
        : "Preparing recap"
      : isStale()
        ? "Notes changed"
        : canReview
          ? "Needs review"
          : recap.outcome === "saved"
            ? "Saved"
            : "Draft";
    select<HTMLElement>("#meeting-status").dataset["status"] = canReview
      ? "review"
      : recap.outcome === "saved" && !isStale()
        ? "saved"
        : "draft";
    title.disabled = workBusy;
    notes.readOnly = workBusy || reading;
    if (reading && !workBusy)
      select<HTMLButtonElement>("#start").innerHTML = `${icon("spark")}Create reading brief`;
  }
  function renderAnswer(body: HTMLElement, content: string): void {
    body.replaceChildren();
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const paragraph = document.createElement("p");
      paragraph.className = /^\s*[-*] /.test(line) ? "message-bullet" : "";
      const text = line.replace(/^#{1,4}\s+/, "").replace(/^\s*[-*] /, "• ");
      for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
        if (part.startsWith("**") && part.endsWith("**")) {
          const emphasis = document.createElement("strong");
          emphasis.textContent = part.slice(2, -2);
          paragraph.append(emphasis);
        } else paragraph.append(document.createTextNode(part));
      }
      body.append(paragraph);
    }
  }
  function addMessage(kind: "user" | "assistant" | "activity", content: string): HTMLElement {
    const item = document.createElement("div");
    item.className = `chat-message ${kind}`;
    if (kind === "assistant") {
      const label = document.createElement("strong");
      label.textContent = reading ? "Reading companion" : "Daybook";
      item.append(label);
    }
    const body = document.createElement("div");
    body.className = "message-content";
    if (kind === "assistant") renderAnswer(body, content);
    else body.textContent = content;
    item.append(body);
    chat.append(item);
    chat.scrollTop = chat.scrollHeight;
    return body;
  }
  function renderChat(messages: StoredMessage[] = []): void {
    chat.replaceChildren();
    if (!messages.length) {
      const welcome = document.createElement("div");
      welcome.className = "assistant-welcome";
      welcome.innerHTML = `${icon("spark")}<h3>${reading ? "Make room for a good idea." : "A little help with the follow-through."}</h3><p>${reading ? "Ask about the argument, follow a connection to another document, or save a reading brief with excerpts from the source." : "Ask about these notes, find earlier decisions, or turn the conversation into a recap your team can act on."}</p>`;
      chat.append(welcome);
      return;
    }
    for (const message of messages) {
      const kind = message.type ?? message.role;
      if (kind === "tool") {
        addMessage(
          "activity",
          `✓ ${message.name === "read_project_context" ? "Read project context" : message.name === "search_meeting_archive" ? "Searched previous meetings" : message.name === "read_document" ? "Read the source document" : message.name === "search_library" ? "Searched your library" : "Tool completed"}`,
        );
        continue;
      }
      const content = textContent(message.content);
      if (content && ["human", "user", "ai", "assistant"].includes(kind ?? ""))
        addMessage(kind === "human" || kind === "user" ? "user" : "assistant", content);
    }
  }
  function renderRecap(): void {
    const hasRecap = Array.isArray(recap.actions);
    select<HTMLElement>("#empty-recap").hidden = hasRecap;
    select<HTMLElement>("#review-form").hidden = !hasRecap;
    select<HTMLElement>("#recap-indicator").hidden = !hasRecap;
    select<HTMLTextAreaElement>("#recap-summary").value = recap.summary ?? "";
    select<HTMLTextAreaElement>("#recap-summary").readOnly = !reviewing;
    const decisions = select<HTMLElement>("#decisions");
    decisions.replaceChildren();
    for (const decision of recap.decisions ?? []) {
      const item = document.createElement("li");
      item.textContent = decision;
      decisions.append(item);
    }
    if (hasRecap && !decisions.children.length) {
      const item = document.createElement("li");
      item.textContent = "No decisions recorded.";
      decisions.append(item);
    }
    const actions = select<HTMLElement>("#actions");
    actions.replaceChildren();
    for (const [index, action] of (recap.actions ?? []).entries()) {
      const row = document.createElement("div");
      row.className = "action-row";
      const count = document.createElement("span");
      count.className = "action-number";
      count.textContent = String(index + 1);
      row.append(count);
      const fields = document.createElement("div");
      fields.className = "action-fields";
      for (const [name, label, maximum] of [
        ["task", "Follow-up", 1000],
        ["owner", "Owner", 100],
        ["due", "Due", 100],
      ] as const) {
        const wrapper = document.createElement("label");
        wrapper.textContent = label;
        wrapper.className = `action-${name}`;
        const input = document.createElement("input");
        input.name = name;
        input.value = action[name];
        input.required = true;
        input.maxLength = maximum;
        input.readOnly = !reviewing;
        wrapper.append(input);
        fields.append(wrapper);
      }
      row.append(fields);
      actions.append(row);
    }
    select<HTMLElement>("#action-count").textContent = `${recap.actions?.length ?? 0} items`;
    select<HTMLElement>("#actions").hidden = reading;
    select<HTMLElement>("#reading-evidence").hidden = !reading;
    if (reading) {
      const questions = select<HTMLElement>("#reading-questions");
      questions.replaceChildren();
      for (const question of recap.questions ?? []) {
        const item = document.createElement("li");
        item.textContent = question;
        questions.append(item);
      }
      const quotes = select<HTMLElement>("#source-quotes");
      quotes.replaceChildren();
      for (const quote of recap.quotes ?? []) {
        const item = document.createElement("blockquote");
        item.textContent = quote;
        quotes.append(item);
      }
      select<HTMLElement>("#action-count").textContent =
        `${recap.questions?.length ?? 0} questions`;
    }
    select<HTMLElement>("#saved-result").hidden = recap.outcome !== "saved";
    select<HTMLElement>("#saved-path").textContent = recap.savedPath ?? "";
    updateControls();
  }
  async function optionalItem(namespace: string[], key: string) {
    try {
      return await client.store.getItem(namespace, key);
    } catch (error) {
      if (typeof error === "object" && error && "status" in error && error.status === 404)
        return null;
      throw error;
    }
  }
  async function refreshHistory(): Promise<void> {
    threads = await client.threads.search({
      metadata: { demo: demoKind },
      limit: 50,
      sortBy: "updated_at",
      sortOrder: "desc",
    });
    await renderHistory();
  }
  async function renderHistory(): Promise<void> {
    const query = search.value.trim();
    const archived = query
      ? await client.store.searchItems([archiveNamespace], { query, limit: 50 })
      : undefined;
    if (query !== search.value.trim()) return;
    const matching = query
      ? threads.filter(
          (thread) =>
            String(thread.metadata?.["title"] ?? "")
              .toLowerCase()
              .includes(query.toLowerCase()) ||
            archived?.items.some((item) => item.key === thread.thread_id),
        )
      : threads;
    const history = select<HTMLElement>("#history");
    history.replaceChildren();
    select<HTMLElement>("#meeting-count").textContent = String(threads.length);
    for (const meeting of matching) {
      const button = document.createElement("button");
      button.className = "history-item";
      button.setAttribute("aria-current", String(meeting.thread_id === threadId));
      const symbol = document.createElement("span");
      symbol.className = "history-icon";
      symbol.innerHTML = icon("note");
      const details = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = String(
        meeting.metadata?.["title"] || (reading ? "Untitled document" : "Untitled meeting"),
      );
      const status = document.createElement("small");
      status.textContent =
        meeting.status === "busy"
          ? "Preparing…"
          : meeting.status === "interrupted"
            ? "Needs review"
            : meeting.status === "error"
              ? "Needs attention"
              : meeting.values?.outcome === "saved"
                ? reading
                  ? "Saved brief"
                  : "Saved recap"
                : "Notes";
      details.append(name, status);
      button.append(symbol, details);
      button.onclick = () => {
        void loadMeeting(meeting.thread_id).catch(showError);
      };
      history.append(button);
    }
    if (!matching.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = query
        ? reading
          ? "No documents found."
          : "No meetings found."
        : reading
          ? "Your documents will appear here."
          : "Your meetings will appear here.";
      history.append(empty);
    }
  }
  async function persistDraft(): Promise<void> {
    if (loading || !threadId) return;
    if (draftSave) clearTimeout(draftSave);
    const id = threadId;
    const snapshot = {
      title: title.value.trim() || (reading ? "Untitled document" : "Untitled meeting"),
      notes: notes.value,
    };
    select<HTMLElement>("#save-status").textContent = "Saving…";
    draftWrite = draftWrite
      .catch(() => undefined)
      .then(async () => {
        await client.store.putItem(["meeting-drafts"], id, snapshot);
        await updateMetadata(id, { title: snapshot.title });
        if (id === threadId) select<HTMLElement>("#save-status").textContent = "Saved locally";
        await refreshHistory();
      });
    await draftWrite;
  }
  function scheduleSave(): void {
    if (loading) return;
    select<HTMLElement>("#save-status").textContent = "Saving…";
    updateControls();
    if (draftSave) clearTimeout(draftSave);
    draftSave = setTimeout(() => {
      void persistDraft().catch(showError);
    }, 600);
  }
  async function createMeeting(sample = false): Promise<void> {
    await persistDraft();
    const thread = await client.threads.create({
      graphId: "workflow",
      metadata: {
        demo: demoKind,
        title: sample
          ? reading
            ? sampleReading.title
            : sampleMeeting.title
          : reading
            ? "Untitled document"
            : "Untitled meeting",
      },
    });
    await loadMeeting(thread.thread_id);
    if (sample) {
      const source = reading ? sampleReading : sampleMeeting;
      title.value = source.title;
      notes.value = source.notes;
    }
    await persistDraft();
    notes.focus();
    updateControls();
  }
  async function loadMeeting(id: string): Promise<void> {
    if (id === threadId && !loading) return;
    if (!loading) await persistDraft();
    const version = ++selectedVersion;
    workStream?.abort();
    chatStream?.abort();
    workBusy = false;
    chatBusy = false;
    loading = true;
    threadId = id;
    assistantId = undefined;
    recap = {};
    reviewing = false;
    errorNotice.hidden = true;
    try {
      const [thread, state, draft] = await Promise.all([
        client.threads.get(id),
        client.threads.getState(id),
        optionalItem(["meeting-drafts"], id),
      ]);
      if (version !== selectedVersion) return;
      title.value = String(
        draft?.value["title"] ?? state.values.title ?? thread.metadata?.["title"] ?? "",
      );
      notes.value = String(draft?.value["notes"] ?? state.values.notes ?? "");
      recap = state.values;
      reviewing = state.next.includes("approve");
      assistantId = String(thread.metadata?.["assistant_thread_id"] ?? "") || undefined;
      select<HTMLElement>("#meeting-date").textContent = new Date(
        thread.created_at,
      ).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      select<HTMLElement>("#save-status").textContent = "Saved locally";
      renderRecap();
      setTab(Array.isArray(recap.actions) && !isStale() ? "recap" : "notes");
      const assistantState = assistantId
        ? await client.threads.getState<ChatState>(assistantId)
        : undefined;
      if (version !== selectedVersion) return;
      renderChat(assistantState?.values.messages);
      await activity.refresh(id);
      await renderHistory();
      const active = (await client.runs.list(id, { limit: 30 })).find((run) =>
        ["pending", "running"].includes(run.status),
      );
      if (active) {
        loading = false;
        void watchWork(id, active.run_id).catch(showError);
      }
    } finally {
      if (version === selectedVersion) {
        loading = false;
        updateControls();
      }
    }
  }
  async function refreshRecap(id: string): Promise<void> {
    const state = await client.threads.getState(id);
    if (id !== threadId) return;
    recap = state.values;
    reviewing = state.next.includes("approve");
    renderRecap();
    setTab("recap");
    await activity.refresh(id);
  }
  function progressFrame(
    frame: { event: string; data: unknown },
    toolRows: Map<string, HTMLElement>,
  ): void {
    if (frame.event === "error")
      throw new Error(
        typeof frame.data === "object" && frame.data && "message" in frame.data
          ? String(frame.data.message)
          : "The model request stopped. Check model settings and try again.",
      );
    if (frame.event !== "custom" || typeof frame.data !== "object" || !frame.data) return;
    const value = frame.data as { progress?: string; type?: string; name?: string; phase?: string };
    if (value.progress) select<HTMLElement>("#progress-label").textContent = value.progress;
    if (value.type === "tool" && value.name) {
      const row = toolRows.get(value.name) ?? addMessage("activity", value.progress ?? value.name);
      row.textContent = `${value.phase === "end" ? "✓" : "↳"} ${value.progress ?? value.name}`;
      toolRows.set(value.name, row);
    }
  }
  async function watchWork(id: string, runId: string): Promise<void> {
    const controller = new AbortController();
    workStream = controller;
    workBusy = true;
    select<HTMLElement>("#progress-label").textContent = reading
      ? "Preparing your reading brief…"
      : "Preparing your recap…";
    updateControls();
    const rows = new Map<string, HTMLElement>();
    try {
      for await (const frame of client.runs.joinStream(id, runId, {
        streamMode: ["values", "custom"],
        signal: controller.signal,
      }))
        if (id === threadId) progressFrame(frame, rows);
      const settled = await client.runs.get(id, runId);
      if (["error", "timeout", "cancelled"].includes(settled.status))
        throw new Error(
          "The recap could not finish. Your notes are saved. Check Settings, then generate it again when you're ready.",
        );
      await refreshRecap(id);
      await refreshHistory();
    } finally {
      if (id === threadId) {
        workBusy = false;
        updateControls();
      }
    }
  }
  async function generate(): Promise<void> {
    if (!threadId || workBusy || !notes.value.trim()) return;
    if (!modelSettings.ready()) {
      modelSettings.open();
      return;
    }
    errorNotice.hidden = true;
    await persistDraft();
    const id = threadId;
    if (reading)
      await client.store.putItem(["reading-library"], id, {
        title: title.value,
        content: notes.value,
      });
    addMessage(
      "activity",
      reading
        ? "Reading your document and preparing a brief with source excerpts."
        : "Preparing a recap from your notes, project context and saved meetings.",
    );
    const run = await client.runs.create(id, "workflow", {
      input: {
        title: title.value.trim() || "Untitled document",
        notes: notes.value,
        documentId: id,
        application,
      },
      streamMode: ["values", "custom"],
      metadata: {
        demo_action: reading ? "Create reading brief" : "Generate recap",
      },
    });
    await refreshHistory();
    await watchWork(id, run.run_id);
  }
  function editedActions(): MeetingAction[] {
    return Array.from(
      select<HTMLElement>("#actions").querySelectorAll<HTMLElement>(".action-row"),
      (row) => ({
        owner: row.querySelector<HTMLInputElement>('[name="owner"]')!.value.trim(),
        task: row.querySelector<HTMLInputElement>('[name="task"]')!.value.trim(),
        due: row.querySelector<HTMLInputElement>('[name="due"]')!.value.trim(),
      }),
    );
  }
  async function approve(approved: boolean): Promise<void> {
    if (!threadId || workBusy) return;
    if (approved && !select<HTMLFormElement>("#review-form").reportValidity()) return;
    const id = threadId;
    const run = await client.runs.create(id, "workflow", {
      command: {
        resume: {
          approved,
          actions: editedActions(),
          summary: select<HTMLTextAreaElement>("#recap-summary").value,
        },
      },
      streamMode: ["values", "custom"],
      metadata: { demo_action: approved ? "Approve and save recap" : "Dismiss draft" },
    });
    await watchWork(id, run.run_id);
  }
  async function branchDraft(checkpointId: string): Promise<void> {
    if (!threadId || workBusy) return;
    const original = threadId;
    const branch = await client.threads.copy(original);
    const branchTitle = `${title.value.slice(0, 170)} · alternative`;
    await updateMetadata(branch.thread_id, {
      demo: demoKind,
      title: branchTitle,
      branched_from: original,
      assistant_thread_id: "",
    });
    await client.threads.updateState(branch.thread_id, {
      checkpointId,
      asNode: "draft",
      values: { title: branchTitle, outcome: "review", savedPath: "" },
    });
    select<HTMLDialogElement>("#activity-dialog").close();
    await loadMeeting(branch.thread_id);
    const run = await client.runs.create(branch.thread_id, "workflow", {
      input: null,
      streamMode: ["values", "custom"],
      metadata: { demo_action: "Create alternative from draft" },
    });
    await watchWork(branch.thread_id, run.run_id);
  }
  async function sendMessage(message?: string): Promise<void> {
    const input = select<HTMLTextAreaElement>("#chat-input");
    const prompt = (message ?? input.value).trim();
    if (!prompt || !threadId || chatBusy) return;
    if (!modelSettings.ready()) {
      modelSettings.open();
      return;
    }
    const meetingId = threadId;
    errorNotice.hidden = true;
    input.value = "";
    if (!assistantId) {
      const thread = await client.threads.create({
        graphId: "assistant",
        metadata: { demo: "meeting-chat", meeting_id: meetingId },
      });
      assistantId = thread.thread_id;
      await updateMetadata(meetingId, { assistant_thread_id: assistantId });
    }
    const id = assistantId;
    if (chat.querySelector(".assistant-welcome")) chat.replaceChildren();
    addMessage("user", prompt);
    const answer = addMessage("assistant", "");
    const controller = new AbortController();
    chatStream = controller;
    chatBusy = true;
    select<HTMLElement>("#progress-label").textContent = "Thinking about your question…";
    updateControls();
    const rows = new Map<string, HTMLElement>();
    let streamed = "";
    try {
      if (reading)
        await client.store.putItem(["reading-library"], meetingId, {
          title: title.value,
          content: notes.value,
        });
      const run = await client.runs.create(id, "assistant", {
        input: {
          messages: [{ role: "user", content: prompt }],
          meetingContext: JSON.stringify({
            documentId: meetingId,
            title: title.value,
            notes: notes.value,
            recap,
          }),
        },
        streamMode: ["messages", "custom", "values"],
      });
      for await (const frame of client.runs.joinStream(id, run.run_id, {
        streamMode: ["messages", "custom", "values"],
        signal: controller.signal,
      })) {
        if (meetingId !== threadId) continue;
        progressFrame(frame, rows);
        if (frame.event === "messages" || frame.event === "messages/partial") {
          const chunk = Array.isArray(frame.data) ? frame.data[0] : frame.data;
          streamed += textContent(chunk?.content);
          renderAnswer(answer, streamed);
          chat.scrollTop = chat.scrollHeight;
        }
      }
      const settled = await client.runs.get(id, run.run_id);
      if (["error", "timeout"].includes(settled.status))
        throw new Error("The assistant could not answer. Check Settings and try again.");
      if (meetingId === threadId)
        renderChat((await client.threads.getState<ChatState>(id)).values.messages);
    } finally {
      if (meetingId === threadId) {
        chatBusy = false;
        updateControls();
      }
    }
  }
  title.oninput = scheduleSave;
  notes.oninput = scheduleSave;
  notes.onblur = () => {
    void persistDraft().catch(showError);
  };
  select<HTMLButtonElement>("#new-meeting").onclick = () => {
    if (reading) select<HTMLInputElement>("#import-file").click();
    else void createMeeting().catch(showError);
  };
  select<HTMLInputElement>("#import-file").onchange = (event) => {
    const picker = event.target as HTMLInputElement;
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    void file
      .text()
      .then(async (content) => {
        if (content.length > 30000)
          throw new Error(
            "Choose a text or Markdown document under 30,000 characters for this example.",
          );
        await createMeeting();
        title.value = file.name.replace(/\.(txt|md)$/i, "");
        notes.value = content;
        await persistDraft();
        updateControls();
      })
      .catch(showError);
  };
  select<HTMLButtonElement>("#sample").onclick = () => {
    void createMeeting(true).catch(showError);
  };
  select<HTMLButtonElement>("#start").onclick = () => {
    void generate().catch(showError);
  };
  select<HTMLButtonElement>("#approve").onclick = () => {
    void approve(true).catch(showError);
  };
  select<HTMLButtonElement>("#dismiss").onclick = () => {
    void approve(false).catch(showError);
  };
  select<HTMLButtonElement>("#notes-tab").onclick = () => setTab("notes");
  select<HTMLButtonElement>("#recap-tab").onclick = () => setTab("recap");
  select<HTMLFormElement>("#review-form").onsubmit = (event) => event.preventDefault();
  select<HTMLFormElement>("#chat-form").onsubmit = (event) => {
    event.preventDefault();
    void sendMessage().catch(showError);
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-prompt]"))
    button.onclick = () => {
      void sendMessage(button.dataset["prompt"]).catch(showError);
    };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close]"))
    button.onclick = () => select<HTMLDialogElement>(`#${button.dataset["close"]}`).close();
  for (const id of ["#model-settings", "#connection-status"])
    select<HTMLButtonElement>(id).onclick = () => modelSettings.open();
  select<HTMLButtonElement>("#versions").onclick = () => {
    select<HTMLDialogElement>("#activity-dialog").showModal();
    if (threadId) void activity.refresh(threadId).catch(showError);
  };
  select<HTMLButtonElement>("#branch").onclick = () => {
    if (!threadId) return;
    void client.threads
      .getHistory(threadId)
      .then((history) => {
        const draft = history.find(
          (state) => state.next.includes("approve") && state.values.outcome === "review",
        );
        if (draft?.checkpoint.checkpoint_id) return branchDraft(draft.checkpoint.checkpoint_id);
        throw new Error("No earlier review draft is available.");
      })
      .catch(showError);
  };
  select<HTMLButtonElement>("#project-settings").onclick = () => {
    void optionalItem(["meeting-workspace"], "project")
      .then((item) => {
        select<HTMLTextAreaElement>("#project-context").value = String(
          item?.value["context"] ?? "",
        );
        select<HTMLDialogElement>("#project-dialog").showModal();
      })
      .catch(showError);
  };
  select<HTMLFormElement>("#project-form").onsubmit = (event) => {
    event.preventDefault();
    void client.store
      .putItem(["meeting-workspace"], "project", {
        context: select<HTMLTextAreaElement>("#project-context").value,
      })
      .then(() => select<HTMLDialogElement>("#project-dialog").close())
      .catch(showError);
  };
  select<HTMLButtonElement>("#download").onclick = () => {
    if (!recap.actions || !recap.decisions) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          meetingMarkdown({
            title: title.value,
            notes: notes.value,
            actions: recap.actions,
            decisions: recap.decisions,
            summary: recap.summary,
            application: recap.application,
            quotes: recap.quotes,
            questions: recap.questions,
          }),
        ],
        { type: "text/markdown;charset=utf-8" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.value.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 80) || "meeting"}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.oninput = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void renderHistory().catch(showError);
    }, 200);
  };
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      if (reading) select<HTMLInputElement>("#import-file").click();
      else void createMeeting().catch(showError);
    }
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      search.focus();
    }
    if (event.key === "Enter" && document.activeElement === select<HTMLElement>("#chat-input")) {
      event.preventDefault();
      void sendMessage().catch(showError);
    }
  });
  renderChat();
  updateControls();
  try {
    await modelSettings.refresh();
    await refreshHistory();
    if (threads[0]) await loadMeeting(threads[0].thread_id);
    else await createMeeting();
  } catch (error) {
    showError(error);
  }
}
