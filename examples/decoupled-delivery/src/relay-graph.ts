import { Annotation, END, interrupt, Send, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";

import { refundApprovers, type RefundApprovalRole } from "./approval-roles.js";
import { declareDestinationDelivery } from "./workflow-delivery.js";

const refundDecisionSchema = z.object({
  actor: z.string().min(1),
  outcome: z.enum(["approve", "reject"]),
  providerEventId: z.string().min(1),
  decidedAt: z.string().datetime(),
});

interface RefundDecision extends z.infer<typeof refundDecisionSchema> {
  role: RefundApprovalRole;
}

const RelayState = Annotation.Root({
  source: Annotation<"email" | "whatsapp">,
  eventId: Annotation<string>,
  conversationId: Annotation<string>,
  from: Annotation<string>,
  body: Annotation<string>,
  subject: Annotation<string | undefined>,
  whatsappNumber: Annotation<string | undefined>,
  emailAddress: Annotation<string | undefined>,
  priority: Annotation<"low" | "high" | undefined>,
  requiresApproval: Annotation<boolean | undefined>,
  refundAmount: Annotation<number | undefined>,
  refundReason: Annotation<string | undefined>,
  approvalRole: Annotation<RefundApprovalRole | undefined>,
  assignedPrincipal: Annotation<string | undefined>,
  approvalWhatsappNumber: Annotation<string | undefined>,
  decisions: Annotation<RefundDecision[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

type RelayStateValue = typeof RelayState.State;

interface GraphConfig {
  configurable?: Record<string, unknown>;
  writer?: (chunk: unknown) => void;
}

function routeDelivery(state: RelayStateValue, config: GraphConfig): Partial<RelayStateValue> {
  if (state.source === "whatsapp") {
    if (!state.emailAddress) throw new Error("A WhatsApp instruction needs an email destination.");
    declareDestinationDelivery(config.writer, {
      destination: "email",
      target: { to: state.emailAddress },
      payload: {
        subject: "Dayweaver instruction",
        body: state.body,
      },
    });
    return {};
  }

  if (state.priority === "low") return {};

  if (state.subject === "route:missing") {
    declareDestinationDelivery(config.writer, {
      destination: "not-configured",
      target: {},
      payload: {},
    });
    return {};
  }

  if (state.requiresApproval === true) {
    if (!state.refundAmount || !state.refundReason) {
      throw new Error("A refund approval needs an amount and reason.");
    }
    declareDestinationDelivery(config.writer, {
      destination: "whatsapp-approval-batch",
      target: { refundId: state.conversationId },
      payload: { kind: "refund-approval-batch" },
    });
    return {};
  }

  if (!state.whatsappNumber) throw new Error("An important email needs a WhatsApp destination.");
  declareDestinationDelivery(config.writer, {
    destination: "whatsapp",
    target: { to: state.whatsappNumber },
    payload: { body: `Important email from ${state.from}: ${state.subject ?? state.body}` },
  });
  return {};
}

function nextAfterRouting(state: RelayStateValue): typeof END | Send[] {
  if (state.source !== "email" || state.requiresApproval !== true) return END;
  return refundApprovers.map(
    (approver) =>
      new Send("collect-refund-approval", {
        ...state,
        approvalRole: approver.role,
        assignedPrincipal: approver.principal,
        approvalWhatsappNumber: approver.whatsappNumber,
      }),
  );
}

function collectRefundApproval(
  state: RelayStateValue,
  config: GraphConfig,
): Partial<RelayStateValue> {
  const role = state.approvalRole;
  const assignedPrincipal = state.assignedPrincipal;
  const whatsappNumber = state.approvalWhatsappNumber;
  if (!role || !assignedPrincipal || !whatsappNumber) {
    throw new Error("The approval task is missing its role assignment.");
  }

  for (;;) {
    const candidate = refundDecisionSchema.parse(
      interrupt({
        kind: "refund-approval",
        refundId: state.conversationId,
        role,
        assignedPrincipal,
        whatsappNumber,
        amount: state.refundAmount,
        reason: state.refundReason,
      }),
    );
    const authenticatedActor = config.configurable?.["langgraph_auth_user_id"];
    if (candidate.actor === assignedPrincipal && authenticatedActor === assignedPrincipal) {
      return { decisions: [{ role, ...candidate }] };
    }
  }
}

function finalizeRefund(state: RelayStateValue, config: GraphConfig): Partial<RelayStateValue> {
  const approved =
    state.decisions.length === refundApprovers.length &&
    state.decisions.every((decision) => decision.outcome === "approve");
  declareDestinationDelivery(config.writer, {
    destination: "email",
    target: { to: state.from },
    payload: {
      subject: approved ? "Refund approved" : "Refund rejected",
      body: approved
        ? `Refund ${state.conversationId} was approved by HR, Manager and Finance.`
        : `Refund ${state.conversationId} was rejected.`,
    },
  });
  return {};
}

export const graph = new StateGraph(RelayState)
  .addNode("route-delivery", routeDelivery)
  .addNode("collect-refund-approval", collectRefundApproval)
  .addNode("finalize-refund", finalizeRefund)
  .addEdge(START, "route-delivery")
  .addConditionalEdges("route-delivery", nextAfterRouting, ["collect-refund-approval", END])
  .addEdge("collect-refund-approval", "finalize-refund")
  .addEdge("finalize-refund", END)
  .compile();
