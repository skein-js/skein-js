import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveProtocolRuntime } from "@skein-js/server-kit";

import { refundApprovers, type RefundApprovalRole } from "./approval-roles.js";
import { recordedEffects, resetRecordedDeliveries } from "./delivery-recorder.js";
import { EMAIL_SOURCE_SECRET } from "./email-source.js";
import { WHATSAPP_SOURCE_SECRET } from "./whatsapp-source.js";

const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "langgraph.json");
const conversationId = "refund-demo-1042";

interface PendingApproval {
  id: string;
  value: {
    role: RefundApprovalRole;
    assignedPrincipal: string;
    whatsappNumber: string;
  };
}

export type DemoWriter = (line: string) => void;

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

async function until(predicate: () => Promise<boolean> | boolean, description: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

/** Run the realistic refund relay through Skein's resolved channel/runtime path. */
export async function runRefundDemo(write: DemoWriter = console.log): Promise<void> {
  resetRecordedDeliveries();
  const resolved = await resolveProtocolRuntime({ config: configPath });

  try {
    write("1. Email received: refund KES 27,500 for a duplicate order charge.");
    const created = await resolved.runtime.handlers.handleInboundEvent(
      providerRequest("email", EMAIL_SOURCE_SECRET, {
        eventId: "email-refund-demo",
        conversationId,
        from: "customer@example.com",
        subject: "Refund request for order GT-1042",
        body: "We were charged twice for order GT-1042.",
        whatsappNumber: "whatsapp:+254700000001",
        priority: "high",
        requiresApproval: true,
        refundAmount: 27_500,
        refundReason: "Duplicate order charge",
      }),
    );
    if (created.status !== 202) throw new Error(`Email intake returned ${created.status}.`);

    await until(async () => {
      const thread = await resolved.runtime.service.threads.get(`relay:${conversationId}`);
      return thread.status === "interrupted" && recordedEffects().length === 3;
    }, "three approval requests");

    const thread = await resolved.runtime.service.threads.get(`relay:${conversationId}`);
    const approvals = Object.values(thread.interrupts ?? {}).flat() as PendingApproval[];
    write("2. LangGraph paused on three parallel approvals:");
    for (const approval of approvals) {
      write(`   - ${approval.value.role} -> ${approval.value.whatsappNumber}`);
    }

    const decisionOrder = ["finance", "hr", "manager"] as const;
    for (const role of decisionOrder) {
      const pending = approvals.find((approval) => approval.value.role === role);
      const approver = refundApprovers.find((candidate) => candidate.role === role);
      if (!pending || !approver) throw new Error(`Missing ${role} approval.`);

      write(`3. ${role} approves over authenticated WhatsApp.`);
      const response = await resolved.runtime.handlers.handleInboundEvent(
        providerRequest("whatsapp", WHATSAPP_SOURCE_SECRET, {
          kind: "approval",
          eventId: `whatsapp-refund-demo-${role}`,
          conversationId,
          from: approver.whatsappNumber,
          body: "approve",
          decision: "approve",
          interruptId: pending.id,
        }),
      );
      if (response.status !== 202) throw new Error(`${role} approval returned ${response.status}.`);
      await until(async () => {
        const current = await resolved.runtime.service.threads.get(`relay:${conversationId}`);
        const values = current.values as unknown as { decisions?: unknown[] };
        return (values.decisions?.length ?? 0) === decisionOrder.indexOf(role) + 1;
      }, `${role} decision`);
    }

    await until(() => recordedEffects().length === 4, "final refund email");
    const settled = await resolved.runtime.service.threads.get(`relay:${conversationId}`);
    const values = settled.values as unknown as {
      decisions: Array<{ role: string; actor: string; outcome: string; providerEventId: string }>;
    };
    const finalEmail = recordedEffects()[3];

    write(`4. Final destination: email -> ${JSON.stringify(finalEmail?.target)}.`);
    write(`   ${JSON.stringify(finalEmail?.payload)}`);
    write("5. Checkpointed decision audit trail:");
    for (const decision of values.decisions) {
      write(
        `   - ${decision.role}: ${decision.outcome} by ${decision.actor} (${decision.providerEventId})`,
      );
    }
  } finally {
    await resolved.runtime.worker.stop();
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await runRefundDemo();
}
