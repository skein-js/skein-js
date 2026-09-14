const scenarios = {
  "important-email": {
    source: "Email",
    fields: [
      ["from", "From", "email", "customer@example.com"],
      ["subject", "Subject", "text", "Urgent: delivery address changed"],
      ["body", "Message", "textarea", "Please update order GT-1042 before dispatch."],
      ["whatsappNumber", "WhatsApp destination", "text", "whatsapp:+254700000001"],
    ],
  },
  instruction: {
    source: "WhatsApp",
    fields: [
      ["from", "From", "text", "whatsapp:+254700000001"],
      ["body", "Message", "textarea", "Send me today's order exceptions."],
      ["emailAddress", "Email destination", "email", "operator@example.com"],
    ],
  },
  refund: {
    source: "Email",
    fields: [
      ["from", "Customer email", "email", "customer@example.com"],
      ["subject", "Subject", "text", "Refund request for order GT-1042"],
      ["body", "Message", "textarea", "I was charged twice for order GT-1042."],
      ["refundAmount", "Amount (KES)", "number", "27500"],
      ["refundReason", "Reason", "text", "Duplicate order charge"],
    ],
  },
};

const state = {
  scenario: "important-email",
  conversationId: "",
  timer: undefined,
  seenDeliveries: 0,
  submittedInterrupts: new Set(),
};
const fields = document.querySelector("#fields");
const form = document.querySelector("#event-form");
const activityList = document.querySelector("#activity-list");
const graphStatus = document.querySelector("#graph-status");
const approvals = document.querySelector("#approvals");
const approvalList = document.querySelector("#approval-list");
const deliveryList = document.querySelector("#deliveries");
const emptyResult = document.querySelector("#empty-result");

function renderFields() {
  fields.replaceChildren();
  const scenario = scenarios[state.scenario];
  for (const [name, label, type, value] of scenario.fields) {
    const wrapper = document.createElement("label");
    const labelText = document.createElement("span");
    labelText.textContent = label;
    wrapper.append(labelText);
    const input = document.createElement(type === "textarea" ? "textarea" : "input");
    input.name = name;
    input.value = value;
    input.required = true;
    if (type !== "textarea") input.type = type;
    wrapper.append(input);
    fields.append(wrapper);
  }
}

function addActivity(message, tone = "") {
  activityList.querySelector(".muted")?.remove();
  const item = document.createElement("li");
  item.className = tone;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const text = document.createElement("span");
  text.textContent = message;
  item.append(time, text);
  activityList.prepend(item);
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function renderDeliveries(deliveries) {
  emptyResult.classList.toggle("hidden", deliveries.length > 0);
  deliveryList.replaceChildren();
  for (const delivery of deliveries) {
    const card = document.createElement("article");
    card.className = "delivery-card";
    const details = document.createElement("div");
    details.append(
      textElement("small", "", delivery.destination),
      textElement("strong", "", delivery.target?.to ?? delivery.target?.refundId ?? "batch"),
      textElement(
        "p",
        "",
        delivery.payload?.body ?? delivery.payload?.subject ?? "Approval request delivered",
      ),
    );
    card.append(
      textElement("div", "delivery-icon", delivery.destination.startsWith("whatsapp") ? "WA" : "@"),
      details,
      textElement("span", "delivered", "Delivered"),
    );
    deliveryList.append(card);
  }
  if (deliveries.length > state.seenDeliveries) {
    deliveries
      .slice(state.seenDeliveries)
      .forEach((delivery) => addActivity(`Delivered through ${delivery.destination}.`, "success"));
    state.seenDeliveries = deliveries.length;
  }
}

function renderApprovals(interrupts) {
  const pendingInterrupts = interrupts.filter(
    (interrupt) => !state.submittedInterrupts.has(interrupt.id),
  );
  approvals.classList.toggle("hidden", pendingInterrupts.length === 0);
  approvalList.replaceChildren();
  for (const interrupt of pendingInterrupts) {
    const value = interrupt.value;
    const card = document.createElement("article");
    card.className = "approval-card";
    const heading = document.createElement("div");
    heading.append(
      textElement("span", "role", value.role),
      textElement("small", "", value.whatsappNumber),
    );
    const controls = document.createElement("div");
    controls.className = "decision";
    for (const decision of ["reject", "approve"]) {
      const button = textElement("button", "", decision[0].toUpperCase() + decision.slice(1));
      button.dataset.decision = decision;
      button.addEventListener("click", () => decide(interrupt, button.dataset.decision, card));
      controls.append(button);
    }
    card.append(
      heading,
      textElement("p", "", `KES ${Number(value.amount).toLocaleString()} · ${value.reason}`),
      controls,
    );
    approvalList.append(card);
  }
}

async function decide(interrupt, decision, card) {
  state.submittedInterrupts.add(interrupt.id);
  card.classList.add("busy");
  try {
    await request("/api/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "approval",
        eventId: crypto.randomUUID(),
        conversationId: state.conversationId,
        from: interrupt.value.whatsappNumber,
        body: decision,
        decision,
        interruptId: interrupt.id,
      }),
    });
    addActivity(`${interrupt.value.role} responded “${decision}” over WhatsApp.`);
    card.remove();
    await poll();
  } catch (error) {
    state.submittedInterrupts.delete(interrupt.id);
    addActivity(error.message, "error");
    card.classList.remove("busy");
  }
}

async function poll() {
  if (!state.conversationId) return;
  const current = await request(
    `/api/state?conversationId=${encodeURIComponent(state.conversationId)}`,
  );
  if (!current.thread) return;
  graphStatus.textContent = current.thread.status;
  renderApprovals(current.thread.interrupts ?? []);
  renderDeliveries(current.deliveries ?? []);
  if (["busy", "interrupted"].includes(current.thread.status)) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void poll(), 400);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearTimeout(state.timer);
  state.conversationId = `${state.scenario}-${Date.now()}`;
  state.seenDeliveries = 0;
  state.submittedInterrupts.clear();
  deliveryList.replaceChildren();
  approvalList.replaceChildren();
  approvals.classList.add("hidden");
  emptyResult.classList.remove("hidden");
  graphStatus.textContent = "Starting";
  form.classList.add("busy");
  try {
    await request("/api/reset", { method: "POST" });
    const values = Object.fromEntries(new FormData(form));
    const base = {
      ...values,
      eventId: crypto.randomUUID(),
      conversationId: state.conversationId,
    };
    const isInstruction = state.scenario === "instruction";
    const payload = isInstruction
      ? { ...base, kind: "instruction" }
      : {
          ...base,
          priority: "high",
          requiresApproval: state.scenario === "refund",
          ...(state.scenario === "refund" ? { refundAmount: Number(values.refundAmount) } : {}),
          whatsappNumber: values.whatsappNumber ?? "whatsapp:+254700000001",
        };
    addActivity(`Received from ${scenarios[state.scenario].source}.`);
    await request(isInstruction ? "/api/whatsapp" : "/api/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    addActivity("Skein accepted the event; LangGraph is routing it.");
    await poll();
  } catch (error) {
    graphStatus.textContent = "Failed";
    addActivity(error.message, "error");
  } finally {
    form.classList.remove("busy");
  }
});

document.querySelectorAll(".scenario").forEach((button) => {
  button.addEventListener("click", () => {
    state.scenario = button.dataset.scenario;
    document.querySelector(".scenario.active")?.classList.remove("active");
    button.classList.add("active");
    renderFields();
  });
});

renderFields();
