export const refundApprovalRoles = ["hr", "manager", "finance"] as const;

export type RefundApprovalRole = (typeof refundApprovalRoles)[number];

export interface RefundApprover {
  role: RefundApprovalRole;
  principal: string;
  whatsappNumber: string;
}

export const refundApprovers: readonly RefundApprover[] = [
  {
    role: "hr",
    principal: "channel:whatsapp:+254700000011",
    whatsappNumber: "whatsapp:+254700000011",
  },
  {
    role: "manager",
    principal: "channel:whatsapp:+254700000012",
    whatsappNumber: "whatsapp:+254700000012",
  },
  {
    role: "finance",
    principal: "channel:whatsapp:+254700000013",
    whatsappNumber: "whatsapp:+254700000013",
  },
];

export function findRefundApproverByNumber(number: string): RefundApprover | undefined {
  return refundApprovers.find((approver) => approver.whatsappNumber === number);
}
