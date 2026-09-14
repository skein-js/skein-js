import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProtocolRuntime } from "@skein-js/server-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { refundApprovers, type RefundApprovalRole } from "./approval-roles.js";
import {
  failNextDeliveries,
  failNextDeliveriesTo,
  recordedAttempts,
  recordedEffects,
  resetRecordedDeliveries,
} from "./delivery-recorder.js";
import { EMAIL_SOURCE_SECRET } from "./email-source.js";
import { WHATSAPP_SOURCE_SECRET } from "./whatsapp-source.js";

const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "langgraph.json");

type Runtime = Awaited<ReturnType<typeof resolveProtocolRuntime>>;
let resolved: Runtime;

beforeEach(async () => {
  resetRecordedDeliveries();
  resolved = await resolveProtocolRuntime({ config: configPath });
});

afterEach(async () => {
  await resolved.runtime.worker.stop();
});

function providerRequest(channel: "email" | "whatsapp", secret: string, body: unknown) {
  return {
    method: "POST",
    url: `http://127.0.0.1:2024/channels/${channel}`,
    headers: { "content-type": "application/json", "x-example-token": secret },
    body: JSON.stringify(body),
    params: {},
    query: {},
  };
}

async function sendEmail(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await resolved.runtime.handlers.handleInboundEvent(
    providerRequest("email", EMAIL_SOURCE_SECRET, {
      eventId: "email-1",
      conversationId: "conversation-1",
      from: "sender@example.com",
      subject: "Important customer request",
      body: "Please review this request.",
      whatsappNumber: "whatsapp:+254700000001",
      priority: "high",
      requiresApproval: false,
      refundAmount: 275,
      refundReason: "Duplicate order charge",
      ...overrides,
    }),
  );
  expect(response.status).toBe(202);
  if (response.kind !== "json") throw new Error("Expected a JSON channel response.");
  return (response.body as { run_id: string }).run_id;
}

async function sendWhatsApp(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await resolved.runtime.handlers.handleInboundEvent(
    providerRequest("whatsapp", WHATSAPP_SOURCE_SECRET, {
      eventId: "whatsapp-1",
      conversationId: "conversation-2",
      from: "whatsapp:+254700000001",
      kind: "instruction",
      body: "Send the customer a progress update.",
      emailAddress: "customer@example.com",
      ...overrides,
    }),
  );
  expect(response.status).toBe(202);
  if (response.kind !== "json") throw new Error("Expected a JSON channel response.");
  return (response.body as { run_id: string }).run_id;
}

async function sendApproval(input: {
  conversationId: string;
  eventId: string;
  from: string;
  interruptId: string;
  decision?: "approve" | "reject";
}) {
  return resolved.runtime.handlers.handleInboundEvent(
    providerRequest("whatsapp", WHATSAPP_SOURCE_SECRET, {
      kind: "approval",
      body: input.decision ?? "approve",
      decision: input.decision ?? "approve",
      ...input,
    }),
  );
}

async function until(
  predicate: () => Promise<boolean> | boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForThreadStatus(
  conversationId: string,
  status: "idle" | "interrupted",
): Promise<void> {
  await until(
    async () =>
      (await resolved.runtime.service.threads.get(`relay:${conversationId}`)).status === status,
    `conversation ${conversationId} to become ${status}`,
  );
}

interface PendingApproval {
  id: string;
  value: {
    role: RefundApprovalRole;
    assignedPrincipal: string;
    whatsappNumber: string;
  };
}

async function pendingApprovals(conversationId: string): Promise<PendingApproval[]> {
  const thread = await resolved.runtime.service.threads.get(`relay:${conversationId}`);
  return Object.values(thread.interrupts ?? {})
    .flat()
    .map((approval) => approval as PendingApproval);
}

async function waitForDecisionCount(conversationId: string, count: number): Promise<void> {
  await until(async () => {
    const thread = await resolved.runtime.service.threads.get(`relay:${conversationId}`);
    const values = thread.values as unknown as Record<string, unknown>;
    return Array.isArray(values["decisions"]) && values["decisions"].length === count;
  }, `${count} refund decisions`);
}

function approvalByRole(
  approvals: readonly PendingApproval[],
  role: RefundApprovalRole,
): PendingApproval {
  const approval = approvals.find((candidate) => candidate.value.role === role);
  if (!approval) throw new Error(`No pending ${role} approval.`);
  return approval;
}

describe("decoupled sources and destinations", () => {
  it("routes an important email to WhatsApp", async () => {
    await sendEmail();

    await until(() => recordedEffects().length === 1, "the WhatsApp delivery");
    expect(recordedEffects()[0]).toMatchObject({
      destination: "whatsapp",
      target: { to: "whatsapp:+254700000001" },
      payload: { body: expect.stringContaining("Important customer request") },
    });
  });

  it("routes a WhatsApp instruction to email through the same graph", async () => {
    await sendWhatsApp();

    await until(() => recordedEffects().length === 1, "the email delivery");
    expect(recordedEffects()[0]).toMatchObject({
      destination: "email",
      target: { to: "customer@example.com" },
      payload: { subject: "Dayweaver instruction" },
    });
  });

  it("conditionally emits nothing for a low-priority email", async () => {
    await sendEmail({ priority: "low" });
    await waitForThreadStatus("conversation-1", "idle");

    expect(recordedEffects()).toEqual([]);
  });

  it("deduplicates a retried source event before it can deliver twice", async () => {
    const firstRunId = await sendEmail();
    const replayedRunId = await sendEmail();

    await until(() => recordedEffects().length === 1, "one WhatsApp delivery");
    expect(replayedRunId).toBe(firstRunId);
    expect(recordedEffects()).toHaveLength(1);
    expect(await resolved.runtime.service.runs.listByThread("relay:conversation-1")).toHaveLength(
      1,
    );
  });

  it("collects HR, manager and Finance approvals in any order before emailing the result", async () => {
    await sendEmail({
      conversationId: "approval-1",
      eventId: "email-approval",
      subject: "Refund request",
      requiresApproval: true,
    });
    await waitForThreadStatus("approval-1", "interrupted");
    await until(() => recordedEffects().length === 3, "three WhatsApp approval requests");
    const initialApprovals = await pendingApprovals("approval-1");
    expect(initialApprovals.map((approval) => approval.value.role).sort()).toEqual([
      "finance",
      "hr",
      "manager",
    ]);

    for (const role of ["finance", "hr", "manager"] as const) {
      const pending = approvalByRole(await pendingApprovals("approval-1"), role);
      const approver = refundApprovers.find((candidate) => candidate.role === role)!;
      const response = await sendApproval({
        conversationId: "approval-1",
        eventId: `whatsapp-approval-${role}`,
        from: approver.whatsappNumber,
        interruptId: pending.id,
      });
      expect(response.status).toBe(202);
      await waitForDecisionCount("approval-1", role === "finance" ? 1 : role === "hr" ? 2 : 3);
      if (role !== "manager") await waitForThreadStatus("approval-1", "interrupted");
    }

    await waitForThreadStatus("approval-1", "idle");
    await until(() => recordedEffects().length === 4, "the refund result email");
    expect(recordedEffects()[3]).toMatchObject({
      destination: "email",
      target: { to: "sender@example.com" },
      payload: { subject: "Refund approved" },
    });

    const thread = await resolved.runtime.service.threads.get("relay:approval-1");
    const values = thread.values as unknown as Record<string, unknown>;
    expect(values["decisions"]).toEqual(
      expect.arrayContaining(
        refundApprovers.map((approver) =>
          expect.objectContaining({
            role: approver.role,
            actor: approver.principal,
            outcome: "approve",
            providerEventId: `whatsapp-approval-${approver.role}`,
            decidedAt: expect.any(String),
          }),
        ),
      ),
    );
  });

  it("does not let a manager answer HR's interrupt", async () => {
    await sendEmail({
      conversationId: "wrong-role",
      eventId: "email-wrong-role",
      requiresApproval: true,
    });
    await waitForThreadStatus("wrong-role", "interrupted");
    const approvals = await pendingApprovals("wrong-role");
    const hr = approvalByRole(approvals, "hr");
    const manager = refundApprovers.find((candidate) => candidate.role === "manager")!;

    const response = await sendApproval({
      conversationId: "wrong-role",
      eventId: "wrong-role-answer",
      from: manager.whatsappNumber,
      interruptId: hr.id,
    });
    expect(response.status).toBe(202);
    await waitForThreadStatus("wrong-role", "interrupted");

    const thread = await resolved.runtime.service.threads.get("relay:wrong-role");
    const values = thread.values as unknown as Record<string, unknown>;
    expect(values["decisions"]).toEqual([]);
    expect(
      (await pendingApprovals("wrong-role")).map((approval) => approval.value.role).sort(),
    ).toEqual(["finance", "hr", "manager"]);
  });

  it("deduplicates a completed approval reply without consuming another role", async () => {
    await sendEmail({
      conversationId: "duplicate-approval",
      eventId: "email-duplicate-approval",
      requiresApproval: true,
    });
    await waitForThreadStatus("duplicate-approval", "interrupted");
    const hr = approvalByRole(await pendingApprovals("duplicate-approval"), "hr");
    const approver = refundApprovers.find((candidate) => candidate.role === "hr")!;
    const request = {
      conversationId: "duplicate-approval",
      eventId: "duplicate-hr-answer",
      from: approver.whatsappNumber,
      interruptId: hr.id,
    };

    const first = await sendApproval(request);
    await waitForDecisionCount("duplicate-approval", 1);
    const replay = await sendApproval(request);
    expect(replay).toEqual(first);
    await waitForDecisionCount("duplicate-approval", 1);
    const thread = await resolved.runtime.service.threads.get("relay:duplicate-approval");
    const values = thread.values as unknown as Record<string, unknown>;
    expect(values["decisions"]).toEqual([
      expect.objectContaining({ role: "hr", providerEventId: "duplicate-hr-answer" }),
    ]);
  });

  it("serializes concurrent approval replies and lets the refused event retry", async () => {
    await sendEmail({
      conversationId: "concurrent-approval",
      eventId: "email-concurrent-approval",
      requiresApproval: true,
    });
    await waitForThreadStatus("concurrent-approval", "interrupted");
    const approvals = await pendingApprovals("concurrent-approval");
    const requests = (["hr", "finance"] as const).map((role) => {
      const approval = approvalByRole(approvals, role);
      const approver = refundApprovers.find((candidate) => candidate.role === role)!;
      return {
        conversationId: "concurrent-approval",
        eventId: `concurrent-${role}`,
        from: approver.whatsappNumber,
        interruptId: approval.id,
      };
    });

    const responses = await Promise.allSettled(requests.map((request) => sendApproval(request)));
    expect(responses.filter((response) => response.status === "fulfilled")).toHaveLength(1);
    expect(responses.filter((response) => response.status === "rejected")).toHaveLength(1);
    await waitForDecisionCount("concurrent-approval", 1);
    await waitForThreadStatus("concurrent-approval", "interrupted");

    const refusedIndex = responses.findIndex((response) => response.status === "rejected");
    const retry = await sendApproval(requests[refusedIndex]!);
    expect(retry.status).toBe(202);
    await waitForDecisionCount("concurrent-approval", 2);
  });

  it("resolves the refund as rejected after all parallel decisions settle", async () => {
    await sendEmail({
      conversationId: "rejected-refund",
      eventId: "email-rejected-refund",
      requiresApproval: true,
    });
    await waitForThreadStatus("rejected-refund", "interrupted");

    for (const role of ["hr", "manager", "finance"] as const) {
      const pending = approvalByRole(await pendingApprovals("rejected-refund"), role);
      const approver = refundApprovers.find((candidate) => candidate.role === role)!;
      await sendApproval({
        conversationId: "rejected-refund",
        eventId: `rejected-${role}`,
        from: approver.whatsappNumber,
        interruptId: pending.id,
        decision: role === "manager" ? "reject" : "approve",
      });
      await waitForDecisionCount("rejected-refund", role === "hr" ? 1 : role === "manager" ? 2 : 3);
      if (role !== "finance") await waitForThreadStatus("rejected-refund", "interrupted");
    }

    await waitForThreadStatus("rejected-refund", "idle");
    await until(() => recordedEffects().length === 4, "the rejected refund email");
    expect(recordedEffects()[3]).toMatchObject({ payload: { subject: "Refund rejected" } });
  });

  it("retries a partial approval batch without duplicating a successful recipient", async () => {
    const manager = refundApprovers.find((candidate) => candidate.role === "manager")!;
    failNextDeliveriesTo(manager.whatsappNumber, 1);
    const runId = await sendEmail({
      conversationId: "approval-retry",
      eventId: "email-approval-retry",
      requiresApproval: true,
    });
    await waitForThreadStatus("approval-retry", "interrupted");
    await until(() => recordedAttempts().length === 2, "the partially failed approval batch");
    expect(recordedEffects()).toHaveLength(1);

    const [failedDelivery] = await resolved.runtime.service.runs.listDeliveries(runId);
    const waitMs = Math.max(
      0,
      new Date(failedDelivery!.next_attempt_at).getTime() - Date.now() + 10,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    expect(await resolved.runtime.deliveryWorker.tickOnce()).toMatchObject({ delivered: 1 });
    await until(() => recordedEffects().length === 3, "the retried approval recipients");

    expect(new Set(recordedEffects().map((effect) => effect.idempotencyKey)).size).toBe(3);
    expect(recordedEffects().map((effect) => effect.target)).toEqual(
      expect.arrayContaining(refundApprovers.map((approver) => ({ to: approver.whatsappNumber }))),
    );
  });

  it("preserves the existing single-answer resume path for ordinary approvals", async () => {
    await sendEmail({
      conversationId: "ordinary-approval",
      eventId: "email-ordinary-approval",
      subject: "Approve supplier payment",
      requiresApproval: false,
    });
    await waitForThreadStatus("ordinary-approval", "idle");
    expect(recordedEffects()).toHaveLength(1);
  });

  it("routes a normal WhatsApp instruction after adding approval messages", async () => {
    await sendWhatsApp({
      conversationId: "approval-1",
      eventId: "whatsapp-instruction-after-approval",
    });
    await waitForThreadStatus("approval-1", "idle");
    await until(() => recordedEffects().length === 1, "the normal WhatsApp instruction email");
    expect(recordedEffects()[0]).toMatchObject({
      destination: "email",
      payload: { subject: "Dayweaver instruction" },
    });
  });

  it("retries a destination failure with the same run id and records one effect", async () => {
    failNextDeliveries("whatsapp", 1);
    const runId = await sendEmail({ conversationId: "retry-1", eventId: "email-retry" });
    await waitForThreadStatus("retry-1", "idle");
    await until(() => recordedAttempts().length === 1, "the failed inline attempt");

    const [failedDelivery] = await resolved.runtime.service.runs.listDeliveries(runId);
    expect(failedDelivery).toMatchObject({ status: "pending", attempt: 1 });
    const waitMs = Math.max(
      0,
      new Date(failedDelivery!.next_attempt_at).getTime() - Date.now() + 10,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    expect(await resolved.runtime.deliveryWorker.tickOnce()).toMatchObject({
      claimed: 1,
      delivered: 1,
    });
    await until(() => recordedEffects().length === 1, "the retried WhatsApp effect");

    expect(recordedAttempts()).toEqual([
      { destination: "whatsapp", runId },
      { destination: "whatsapp", runId },
    ]);
    expect(recordedEffects()).toHaveLength(1);
  });

  it("records an unknown graph-selected destination as a visible delivery failure", async () => {
    const runId = await sendEmail({
      conversationId: "missing-1",
      eventId: "email-missing",
      subject: "route:missing",
    });
    await waitForThreadStatus("missing-1", "idle");

    const [delivery] = await resolved.runtime.service.runs.listDeliveries(runId);
    expect(delivery).toMatchObject({
      status: "pending",
      last_error: expect.stringContaining('No channel destination named "not-configured"'),
    });
    expect(recordedEffects()).toEqual([]);
  });
});
