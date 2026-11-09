export const EUROPE_STEPS = ["Create Card", "Enroll Agentic Token", "Device Binding / Cardholder Verification",
  "Create Purchase Request", "Purchase Verification", "Get Payment Credential", "Confirm Transaction", "Active Instruction"] as const;

export function safeCheckoutOutcome(result: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["status", "intentId", "instructionStatus", "cryptogramId", "confirmationStatus"]) {
    if (typeof result[key] === "string" || result[key] === null) summary[key] = result[key];
  }
  const credential = result.paymentCredential as Record<string, unknown> | undefined;
  if (credential) summary.paymentCredential = {
    dpanLast4: typeof credential.dpanLast4 === "string" ? credential.dpanLast4.slice(-4) : null,
    expiry: typeof credential.expiry === "string" ? credential.expiry : null,
    eci: typeof credential.eci === "string" ? credential.eci : null,
  };
  return summary;
}

export function purchaseStage(status?: string): number {
  if (status === "waiting_for_authentication") return 5;
  if (status === "awaiting_payment_outcome") return 7;
  return 8;
}

export function credentialStepComplete(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== "object") return false;
  const value = outcome as Record<string, unknown>;
  return value.status === "awaiting_payment_outcome" && typeof value.cryptogramId === "string" && value.cryptogramId.length > 0;
}
