import { authorizeV2Payment, v2InstructionOperation, validateV2Config } from "../mcp-server/src/v2-payments.js";

function maskedCredential(value) {
  return { dpanLast4: value.last4 ?? null,
    expiry: value.exp_month && value.exp_year ? `${value.exp_month}/${value.exp_year}` : null,
    cryptogramId: value.cryptogram?.id ?? null, type: value.cryptogram?.type ?? null,
    eci: value.eci ?? null, cryptogramValue: null, cryptogramPreview: "[redacted]" };
}

export function installMockCheckoutRoutes(app, { mockConfig, visaAgent, port = 3000, cards, merchantApi } = {}) {
  if (!mockConfig) return;
  const flows = new Map();
  const api = merchantApi ?? (async (path, { method = "GET", body, allow404 = false } = {}) => {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Invalid merchant path");
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, redirect: "error",
      headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error("The local merchant request did not complete");
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  });
  const ctx = { api, visaFlow: "v2", visaAgent, mockMode: true,
    apiBaseUrl: `http://127.0.0.1:${port}/api`, appBaseUrl: mockConfig.merchantOrigin || "https://localhost:4200",
    defaultBuyerId: "manual-demo", defaultConsumerEmail: "buyer@example.test", defaultEnvironment: "local",
    openBrowser: () => false, maskCredential: maskedCredential,
    getPaymentOutcome: async () => null,
    requestStore: { get: async (id) => flows.get(id), set: async (id, value) => flows.set(id, structuredClone(value)) },
  };
  app.post("/api/mock/checkout", async (req, res) => {
    const { operation, paymentRequestId, buyerId, cardId, simulatedOutcome, evidenceSessionId } = req.body ?? {};
    if (!["authorize", "confirm", "retrieve", "cancel"].includes(operation) || typeof paymentRequestId !== "string"
        || typeof buyerId !== "string" || !buyerId.startsWith("manual-")) return res.status(400).json({ error: "invalid_mock_checkout" });
    try {
      validateV2Config(ctx);
      const payment = await api(`/payment-requests/${encodeURIComponent(paymentRequestId)}`);
      if (payment.buyerId !== buyerId || payment.simulated !== true) throw new Error("Payment request does not match this simulated buyer");
      if (operation === "confirm") {
        if (flows.get(paymentRequestId)?.status !== "awaiting_payment_outcome") throw new Error("Issue a credential before selecting its simulated outcome");
        if (!["APPROVED", "DECLINED", "CANCELLED"].includes(simulatedOutcome)) throw new Error("Select a simulated merchant result");
      }
      if (operation === "authorize" && cardId) await retainEnrollment(api, cards, buyerId, cardId);
      const operationContext = { ...ctx, getPaymentOutcome: operation === "confirm"
        ? async () => ({ transaction_status: simulatedOutcome, simulated: true }) : ctx.getPaymentOutcome };
      const args = { paymentRequestId, buyerId, ...(cardId ? { cardId } : {}) };
      let result;
      if (operation === "cancel") {
        const session = await api(`/sessions/${encodeURIComponent(evidenceSessionId || "")}`);
        const wallet = (await api(`/subscriptions/${encodeURIComponent(buyerId)}`)).subscription;
        if (session.phase !== "PAYMENT" || session.buyerId !== buyerId || session.cardId !== wallet?.cardId
            || session.tokenId !== wallet?.tokenId || !Array.isArray(session.assuranceData) || !session.assuranceData.length) {
          throw new Error("Matching PAYMENT evidence is required to cancel this simulated instruction");
        }
        result = await v2InstructionOperation({ ...args, assuranceData: session.assuranceData }, operationContext, "cancel");
      } else result = operation === "retrieve" ? await v2InstructionOperation(args, operationContext, "retrieve") : await authorizeV2Payment(args, operationContext);
      const wallet = (await api(`/subscriptions/${encodeURIComponent(buyerId)}`)).subscription;
      const instructionStatus = wallet?.intentId === result.intentId
        ? wallet?.instructionStatus ?? result.instructionStatus ?? null : result.instructionStatus ?? null;
      res.json({ ...result, simulated: true, instructionStatus });
    } catch (error) {
      res.status(400).json({ error: error.message, simulated: true });
    }
  });
}

async function retainEnrollment(api, cards, buyerId, cardId) {
  const card = cards?.get(cardId);
  if (!card) throw new Error("Select a saved synthetic fixture card");
  await api(`/merchant/cards/${encodeURIComponent(buyerId)}`, { method: "POST", body: {
    cardId, lastFour: card.lastFour, brand: card.brand,
  } });
  const wallet = (await api(`/subscriptions/${encodeURIComponent(buyerId)}`)).subscription;
  if (wallet?.tokenId || !card.enrollment?.data?.id) return;
  const attrs = card.enrollment.data.attributes ?? {};
  await api(`/subscriptions/${encodeURIComponent(buyerId)}`, { method: "POST", body: {
    cardId, tokenId: card.enrollment.data.id, consumerId: attrs.consumer_id ?? null, deviceId: attrs.device_id ?? null,
    cardholderVerification: attrs.cardholder_verification ?? null, agenticEnrollmentRequired: attrs.agentic_enrollment_required ?? null,
    visaFlow: "v2", status: "enrolled", simulated: true,
  } });
}
