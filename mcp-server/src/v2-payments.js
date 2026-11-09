import { createHash, randomUUID } from "node:crypto";

const localHost = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
const envelope = (type, attributes) => ({ data: { type, attributes } });
const encoded = encodeURIComponent;
const localClaims = new WeakMap();

async function withBuyerClaim(ctx, buyerId, run) {
  const key = createHash('sha256').update(String(buyerId)).digest('hex');
  const store = ctx.requestStore;
  const local = localClaims.get(store) ?? new Set();
  localClaims.set(store, local);
  if (local.has(key)) throw new Error('A payment operation is already in progress for this buyer. Poll again.');
  local.add(key);
  let claimed = false;
  try {
    if (store.claim) {
      claimed = await store.claim(key);
      if (!claimed) throw new Error('A payment operation is in progress or needs recovery. Do not repeat the mutation.');
    }
    return await run();
  } finally {
    try { if (claimed) await store.release(key); }
    finally { local.delete(key); }
  }
}

function credentialUsable(attributes) {
  return attributes?.status === "COMPLETED" && typeof attributes.network_token === "string" && attributes.network_token.length > 0
    && typeof attributes.cryptogram?.value === "string" && attributes.cryptogram.value.length > 0
    && typeof attributes.cryptogram.type === "string" && attributes.cryptogram.type.length > 0;
}

export function validateV2Config(ctx) {
  if (!["v1", "v2"].includes(ctx.visaFlow)) throw new Error("Unsupported Visa flow configuration.");
  if (ctx.mockMode && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("Simulated MCP requires trusted TLS certificates.");
  if (ctx.mockMode && ctx.visaFlow !== "v2") throw new Error("Simulated MCP mode requires Visa v2.");
  if (ctx.visaFlow !== "v2") return;
  if (!ctx.visaAgent) throw new Error("Visa v2 requires an explicitly configured agent.");
  if (ctx.mockMode && (!localHost(ctx.apiBaseUrl) || !localHost(ctx.appBaseUrl))) {
    throw new Error("Simulated MCP payments require local merchant origins.");
  }
}

function query(flow) {
  return new URLSearchParams({ visaFlow: "v2", cardId: flow.cardId, tokenId: flow.tokenId,
    ...(flow.intentId ? { intentId: flow.intentId } : {}) });
}

function transaction(pr, flow) {
  return { mandate_id: flow.mandateId, transaction_reference_id: pr.id,
    merchant_name: "Vellum", merchant_url: flow.merchantUrl,
    transaction_amount: { transaction_amount: Number(pr.amount).toFixed(2), transaction_currency_code: pr.currency } };
}

export function syntheticAgentInputs(agent, operation, buyerId) {
  const now = Math.floor(Date.now() / 1000);
  return { agent, agent_signature: { value: "c3ludGhldGljLW1vY2stc2lnbmF0dXJl", input: {
    alg: "Ed25519", tag: operation === "confirmation" ? "confirmation-request" : "credential-request",
    key_id: "synthetic-mock-key", nonce: randomUUID(), created: String(now), expires: String(now + 300),
  } }, ...(operation === "credential" || operation === "retrieve" ? { encrypted_instruction: `synthetic-mock-instruction-${randomUUID()}` } : {}),
  ...(operation === "credential" ? { consumer: { username: buyerId, email: "buyer@example.test", country_code: "FR", language_code: "en" } } : {}) };
}

async function inputs(ctx, args, operation, pr, flow) {
  const supplied = ctx.getV2Inputs ? await ctx.getV2Inputs({ operation, paymentRequest: pr, flow: { ...flow }, transaction: transaction(pr, flow) })
    : args.agentInputs?.[operation] ?? (ctx.mockMode ? syntheticAgentInputs(ctx.visaAgent, operation, flow.buyerId) : null);
  if (!supplied) return null;
  if (supplied.agent !== ctx.visaAgent) throw new Error("Fresh inputs from the configured agent are required.");
  const allowed = ["agent", "agent_signature", "encrypted_instruction", "consumer", "consumer_id"];
  if (Object.keys(supplied).some((key) => !allowed.includes(key))) throw new Error("Unsupported agent handoff field.");
  if (["credential", "retrieve"].includes(operation) && !supplied.encrypted_instruction) throw new Error("The agent's encrypted instruction is required.");
  return supplied;
}

function paymentEvidence(session, flow) {
  const evidence = session?.assuranceData;
  if (session?.phase !== "PAYMENT" || session.cardId !== flow.cardId || session.tokenId !== flow.tokenId
      || session.buyerId !== flow.buyerId || !Array.isArray(evidence) || !evidence.length
      || evidence.some((item) => item.verificationEntity !== "10" || item.verificationMethod !== "23"
        || !item.methodResults?.fidoAssertionData?.code || !item.methodResults.identifier || !item.methodResults.dfpSessionId)) {
    throw new Error("Matching PAYMENT evidence is required. Registration is not payment evidence.");
  }
  return evidence;
}

function requestScope(pr) {
  return JSON.stringify([pr.id, pr.buyerId, pr.amount, pr.currency, pr.mandate ?? null]);
}

function pending(flow, extra = {}) {
  return { status: flow.status, paymentRequestId: flow.paymentRequestId, cardId: flow.cardId, tokenId: flow.tokenId,
    intentId: flow.intentId ?? null, cryptogramId: flow.cryptogramId ?? null,
    paymentCredential: flow.credential ?? null, visaFlow: "v2", simulated: Boolean(flow.simulated), ...extra };
}

function authorizationMandates(pr, flow) {
  return flow.authorizationMandates ?? [{ mandate_id: flow.mandateId,
    decline_threshold: { amount: pr.amount, currency_code: pr.currency },
    effective_until: flow.intentExpiresAt, quantity: flow.mandateQuantity, preferred_merchant_name: "Vellum" }];
}

async function agentHandoff(ctx, pr, flow, operation, confirmation = null) {
  flow.status = "awaiting_agent_inputs";
  flow.pendingOperation = operation;
  flow.authorizationMandates = authorizationMandates(pr, flow);
  await saveFlow(ctx, flow);
  const current = transaction(pr, flow);
  const encryptedInstructionPayload = ["credential", "retrieve"].includes(operation) ? {
    mandates: flow.authorizationMandates.map((mandate) => ({ mandateId: mandate.mandate_id,
      declineThreshold: { amount: Number(mandate.decline_threshold.amount).toFixed(2), currencyCode: mandate.decline_threshold.currency_code },
      effectiveUntilTime: String(Math.floor(Date.parse(mandate.effective_until) / 1000)),
      quantity: String(mandate.quantity), preferredMerchantName: mandate.preferred_merchant_name })),
    merchantName: current.merchant_name, merchantUrl: current.merchant_url,
    transactionAmount: { transactionAmount: current.transaction_amount.transaction_amount,
      transactionCurrencyCode: current.transaction_amount.transaction_currency_code },
  } : null;
  return pending(flow, { agentHandoff: { operation, agent: ctx.visaAgent, cardId: flow.cardId,
    tokenId: flow.tokenId, intentId: flow.intentId ?? null, consumerId: flow.consumerId ?? null,
    signatureTag: operation === "confirmation" ? "confirmation-request" : operation === "cancel" ? null : "credential-request",
    ...(encryptedInstructionPayload ? { purchaseType: "PURCHASE_HITL", mandates: flow.authorizationMandates,
      transaction: current, encryptedInstructionPayload } : {}),
    ...(confirmation ? { confirmation } : {}),
  }, nextStep: "Provide fresh inputs from the configured agent for this exact operation and scope." });
}

async function saveFlow(ctx, flow) { await ctx.requestStore.set(flow.paymentRequestId, flow); }

async function mutate(ctx, flow, phase, path, body, method = "POST") {
  flow.status = phase;
  await saveFlow(ctx, flow);
  await ctx.api(`/payment-requests/${encoded(flow.paymentRequestId)}`, { method: "PUT", body: {
    status: phase, visaFlow: "v2", cardId: flow.cardId, tokenId: flow.tokenId, intentId: flow.intentId ?? null,
  } });
  try { return await ctx.api(path, { method, body }); }
  catch { throw new Error("Visa v2 outcome is unknown. Inspect the saved operation before retrying."); }
}

async function acquireCard(ctx, args, pr, flow) {
  if (flow.cardId) return true;
  if (args.cardId) {
    const record = await ctx.api(`/merchant/cards/${encoded(flow.buyerId)}`);
    if (!(record.cards ?? []).some((card) => card.cardId === args.cardId)) throw new Error("Select a card saved for this buyer.");
    flow.cardId = args.cardId;
    return true;
  }
  const id = `collect-${pr.id}`;
  const session = await ctx.api(`/sessions/${encoded(id)}`, { allow404: true });
  if (session?.cardId) {
    flow.cardId = session.cardId;
    await ctx.api(`/merchant/cards/${encoded(flow.buyerId)}`, { method: "POST", body: session });
    return true;
  }
  flow.status = "waiting_for_card";
  const url = new URL("/collect.html", ctx.appBaseUrl);
  url.search = new URLSearchParams({ sessionId: id, buyer_id: flow.buyerId });
  flow.collect = { sessionId: id, url: url.href, opened: ctx.openBrowser(url.href) };
  return false;
}

async function acquireToken(ctx, args, flow) {
  if (flow.tokenId) return;
  const wallet = (await ctx.api(`/subscriptions/${encoded(flow.buyerId)}`)).subscription;
  if (wallet?.cardId === flow.cardId && wallet.tokenId && wallet.visaFlow === "v2") {
    flow.tokenId = wallet.tokenId;
    flow.consumerId = wallet.consumerId ?? null;
    flow.deviceId = wallet.deviceId ?? null;
    flow.cardholderVerification = wallet.cardholderVerification ?? null;
    flow.agenticEnrollmentRequired = wallet.agenticEnrollmentRequired ?? null;
    return;
  }
  const consumerId = wallet?.consumerId ?? createHash('sha256').update(ctx.appBaseUrl + '\0' + flow.buyerId).digest('hex').slice(0, 32);
  const response = await mutate(ctx, flow, "enrolling_token", `/cards/${encoded(flow.cardId)}/agentic-tokens`,
    envelope("agentic_tokens", { consumer_email: args.consumerEmail || ctx.defaultConsumerEmail, consumer_id: consumerId, visa_flow: "v2" }));
  if (!response?.data?.id) throw new Error("Visa enrollment returned no token identifier.");
  flow.tokenId = response.data.id;
  flow.consumerId = response.data.attributes?.consumer_id ?? null;
  flow.deviceId = response.data.attributes?.device_id ?? null;
  flow.cardholderVerification = response.data.attributes?.cardholder_verification ?? null;
  flow.agenticEnrollmentRequired = response.data.attributes?.agentic_enrollment_required ?? null;
  await ctx.api(`/subscriptions/${encoded(flow.buyerId)}`, { method: "POST", body: {
    cardId: flow.cardId, tokenId: flow.tokenId, visaFlow: "v2", status: "enrolled", simulated: Boolean(ctx.mockMode),
    consumerId: flow.consumerId, deviceId: flow.deviceId, cardholderVerification: flow.cardholderVerification,
    agenticEnrollmentRequired: flow.agenticEnrollmentRequired,
  } });
}

async function acquireEvidence(ctx, args, pr, flow) {
  const id = `binding-${pr.id}`;
  const session = await ctx.api(`/sessions/${encoded(id)}`, { allow404: true });
  if (session) return paymentEvidence(session, flow);
  const url = new URL("/binding.html", ctx.appBaseUrl);
  url.search = new URLSearchParams({ sessionId: id, buyer_id: flow.buyerId, cardId: flow.cardId,
    tokenId: flow.tokenId, amount: String(pr.amount), currency: pr.currency,
    currency_code: { USD: "840", EUR: "978", GBP: "826" }[pr.currency] || pr.currency,
    merchant_name: "Vellum", consumer_email: args.consumerEmail || ctx.defaultConsumerEmail,
    environment: ctx.defaultEnvironment, preparationMode: "vic-v2-europe" });
  flow.status = "waiting_for_authentication";
  flow.binding = { sessionId: id, url: url.href, opened: ctx.openBrowser(url.href) };
  return null;
}

async function issueFirstCredential(ctx, args, pr, flow, evidence) {
  flow.authorizationMandates = authorizationMandates(pr, flow);
  const agent = await inputs(ctx, args, "credential", pr, flow);
  if (!agent) return agentHandoff(ctx, pr, flow, "credential");
  if (agent.consumer_id && flow.consumerId && agent.consumer_id !== flow.consumerId) throw new Error("Consumer identity does not match enrollment.");
  const response = await mutate(ctx, flow, "issuing_credential", `/cryptograms?${query(flow)}`, envelope("cryptograms", {
    ...agent, ...(flow.consumerId ? { consumer_id: flow.consumerId } : {}), purchase_type: "PURCHASE_HITL", assurance_data: evidence,
    mandates: flow.authorizationMandates,
    transaction: transaction(pr, flow),
  }));
  const attrs = response?.data?.attributes;
  if (!attrs?.intent_id) throw new Error("Visa v2 returned no instruction identifier.");
  flow.intentId = attrs.intent_id;
  flow.consumerId = attrs.consumer_id ?? flow.consumerId;
  flow.credential = ctx.maskCredential(attrs);
  flow.cryptogramId = attrs.cryptogram?.id ?? response.data.id ?? pr.id;
  flow.status = credentialUsable(attrs) ? "awaiting_payment_outcome" : "credential_unavailable";
  await saveFlow(ctx, flow);
  await ctx.api(`/payment-requests/${encoded(pr.id)}`, { method: "PUT", body: {
    status: flow.status, intentId: flow.intentId, cardId: flow.cardId, tokenId: flow.tokenId, visaFlow: "v2", mandateId: flow.mandateId,
  } });
  return flow.status === "credential_unavailable" ? pending(flow, { nextStep: "Credential unavailable. Keep the instruction identifier; do not confirm or publish." })
    : finishV2Payment(ctx, args, pr, flow);
}

async function finishV2Payment(ctx, args, pr, flow) {
  const outcome = flow.paymentOutcome ?? (ctx.getPaymentOutcome ? await ctx.getPaymentOutcome({ paymentRequest: pr, flow: { ...flow } })
    : ctx.mockMode ? { transaction_status: pr.simulatedOutcome ?? "APPROVED", simulated: true } : null);
  if (!outcome || !["APPROVED", "DECLINED", "CANCELLED"].includes(outcome.transaction_status)) {
    flow.status = "awaiting_payment_outcome";
    await saveFlow(ctx, flow);
    return pending(flow, { nextStep: "A merchant payment result is required before confirmation. No payment is confirmed." });
  }
  flow.paymentOutcome = { transaction_status: outcome.transaction_status };
  const used = Number(flow.mandateUsed ?? 0) + (outcome.transaction_status === "APPROVED" ? 1 : 0);
  const exhausted = outcome.transaction_status === "APPROVED";
  const confirmation = flow.confirmationRequest ?? { instruction_completed: exhausted, confirmation_data: [{ mandate_id: flow.mandateId, mandate_status: exhausted ? "COMPLETED" : "ACTIVE",
      transaction_reference_id: pr.id, transaction_status: outcome.transaction_status,
      transaction_timestamp: String(Math.floor(Date.now() / 1000)), transaction_amount: transaction(pr, flow).transaction_amount,
    }],
  };
  flow.confirmationRequest = confirmation;
  const supplied = await inputs(ctx, args, "confirmation", pr, flow);
  if (!supplied) return agentHandoff(ctx, pr, flow, "confirmation", confirmation);
  const response = await mutate(ctx, flow, "confirming_payment", `/confirmations?${query(flow)}`, envelope("confirmations", {
    agent: supplied.agent, ...(supplied.agent_signature ? { agent_signature: supplied.agent_signature } : {}), ...confirmation,
  }));
  if (!response?.data?.id) throw new Error("Visa confirmation returned no identifier.");
  flow.status = outcome.transaction_status === "APPROVED" ? "completed" : "declined";
  flow.confirmationId = response.data.id;
  flow.mandateUsed = used;
  flow.instructionStatus = response.data.attributes?.status ?? null;
  await saveFlow(ctx, flow);
  const proof = { ...pending(flow), cryptogramId: flow.cryptogramId, paymentCredential: flow.credential,
    confirmationId: flow.confirmationId, confirmationStatus: outcome.transaction_status,
    instructionStatus: flow.instructionStatus, mandateId: flow.mandateId, visaFlow: "v2",
    consumerId: flow.consumerId, deviceId: flow.deviceId, cardholderVerification: flow.cardholderVerification,
    agenticEnrollmentRequired: flow.agenticEnrollmentRequired, authorizationMandates: flow.authorizationMandates, mandateQuantity: flow.mandateQuantity, mandateUsed: used,
    intentExpiresAt: flow.intentExpiresAt, amount: pr.amount, currency: pr.currency,
    authorizedPerChargeAmount: flow.authorizedPerChargeAmount ?? pr.amount, completedAt: Date.now(),
    nextStep: ctx.mockMode ? `Simulated ${outcome.transaction_status.toLowerCase()} result recorded. No charge or publication occurred.`
      : "Merchant result recorded. Confirmation is not proof of settlement." };
  await ctx.api(`/payment-requests/${encoded(pr.id)}`, { method: "PUT", body: proof });
  await ctx.api(`/subscriptions/${encoded(flow.buyerId)}`, { method: "POST", body: {
    ...proof, status: flow.instructionStatus === "ACTIVE" ? "active" : "inactive", lastPaymentProof: proof,
  } });
  return proof;
}

export async function authorizeV2Payment(args, ctx) {
  const pr = await ctx.api(`/payment-requests/${encoded(args.paymentRequestId)}`, { allow404: true });
  if (!pr || (ctx.mockMode && pr.simulated !== true)) throw new Error("A matching payment request is required.");
  return withBuyerClaim(ctx, pr.buyerId || ctx.defaultBuyerId, () => authorizeSelectedRequest(args, ctx, pr));
}

async function authorizeSelectedRequest(args, ctx, pr) {
  const id = pr.id;
  const saved = await ctx.requestStore.get(id);
  if (!saved && pr.visaFlow === "v2" && pr.status !== "pending") {
    return { ...pr, status: ["completed", "declined", "credential_unavailable"].includes(pr.status) ? pr.status : "state_recovery_required",
      nextStep: ctx.mockMode ? "Simulated outcome retained. No charge or publication occurred." : "Inspect the existing operation; it was not repeated." };
  }
  const quantity = pr.mandate?.quantity ?? 1;
  const expiry = pr.mandate?.effectiveUntil ?? new Date(pr.expiresAt ?? Date.now() + 10 * 60000).toISOString();
  if ((!saved || !["completed", "declined", "credential_unavailable"].includes(saved.status)) &&
      (!Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) {
    throw new Error("A positive mandate quantity and future expiry are required.");
  }
  const flow = saved ?? { paymentRequestId: id, buyerId: pr.buyerId || ctx.defaultBuyerId,
    simulated: Boolean(ctx.mockMode), mandateId: `mandate-${randomUUID()}`, merchantUrl: ctx.appBaseUrl,
    requestSnapshot: requestScope(pr), consumerEmail: args.consumerEmail || ctx.defaultConsumerEmail,
    mandateQuantity: quantity, mandateUsed: 0, intentExpiresAt: expiry };
  if (flow.requestSnapshot !== requestScope(pr) || (args.cardId && flow.cardId && args.cardId !== flow.cardId)
      || (args.consumerEmail && flow.consumerEmail !== args.consumerEmail)) throw new Error("Payment request scope changed. Start a new request.");
  if (["completed", "declined", "credential_unavailable"].includes(flow.status)) return pending(flow, {
    nextStep: ctx.mockMode ? "Simulated result retained. No charge or publication occurred." : "Existing result retained; no operation was repeated." });
  if (["enrolling_token", "issuing_credential", "confirming_payment"].includes(flow.status)) {
    return pending(flow, { status: "outcome_unknown", nextStep: "Inspect the operation outcome before any retry." });
  }
  if (flow.status === "awaiting_payment_outcome" || (flow.status === "awaiting_agent_inputs" && flow.pendingOperation === "confirmation")) return finishV2Payment(ctx, args, pr, flow);
  if (!await acquireCard(ctx, args, pr, flow)) { await saveFlow(ctx, flow); return pending(flow, { collect: flow.collect, retryAfterSeconds: 3 }); }
  await acquireToken(ctx, args, flow);
  const evidence = await acquireEvidence(ctx, args, pr, flow);
  if (!evidence) { await saveFlow(ctx, flow); return pending(flow, { binding: flow.binding, retryAfterSeconds: 3 }); }
  return issueFirstCredential(ctx, args, pr, flow, evidence);
}

export async function v2InstructionOperation(args, ctx, operation) {
  return withBuyerClaim(ctx, args.buyerId || ctx.defaultBuyerId, () => runInstructionOperation(args, ctx, operation));
}

async function runInstructionOperation(args, ctx, operation) {
  const wallet = (await ctx.api(`/subscriptions/${encoded(args.buyerId || ctx.defaultBuyerId)}`)).subscription;
  if (!wallet || wallet.visaFlow !== "v2" || wallet.status !== "active" || wallet.instructionStatus !== "ACTIVE") {
    throw new Error("An active Visa v2 instruction is required.");
  }
  const pr = await ctx.api(`/payment-requests/${encoded(args.paymentRequestId)}`);
  if (pr.buyerId !== wallet.buyerId || (ctx.mockMode && pr.simulated !== true)) throw new Error("Payment request buyer does not match.");
  const prior = await ctx.requestStore.get(pr.id);
  if ((prior && !(prior.status === "awaiting_agent_inputs" && prior.pendingOperation === operation)) || pr.status !== "pending") throw new Error("This payment request already has an operation. Inspect its existing result.");
  if (wallet.intentExpiresAt && Date.now() >= new Date(wallet.intentExpiresAt).getTime()) throw new Error("The instruction has expired.");
  if (!Number.isInteger(wallet.mandateQuantity) || Number(wallet.mandateUsed ?? 0) >= wallet.mandateQuantity) throw new Error("The mandate has no remaining transactions.");
  if (pr.currency !== wallet.currency || pr.amount > wallet.authorizedPerChargeAmount) throw new Error("Transaction exceeds the mandate scope.");
  const flow = prior ?? { ...wallet, buyerId: wallet.buyerId, merchantUrl: ctx.appBaseUrl, paymentRequestId: pr.id,
    requestSnapshot: requestScope(pr), consumerEmail: ctx.defaultConsumerEmail };
  if (flow.requestSnapshot !== requestScope(pr)) throw new Error("Payment request scope changed. Start a new request.");
  const supplied = await inputs(ctx, args, operation, pr, flow);
  if (!supplied) return agentHandoff(ctx, pr, flow, operation);
  if (operation === "cancel") {
    const result = await mutate(ctx, flow, "canceling_instruction", `/intents?${query(flow)}`, envelope("intents", {
      agent: supplied.agent, ...(supplied.agent_signature ? { agent_signature: supplied.agent_signature } : {}),
      ...(args.assuranceData ? { assurance_data: args.assuranceData } : {}),
    }), "DELETE");
    flow.status = "canceled";
    await saveFlow(ctx, flow);
    await ctx.api(`/subscriptions/${encoded(flow.buyerId)}`, { method: "POST", body: { status: "canceled", instructionStatus: "CANCELLED" } });
    return { status: "canceled", intentId: flow.intentId, simulated: Boolean(ctx.mockMode), result };
  }
  const response = await mutate(ctx, flow, "issuing_credential", `/cryptograms?${query(flow)}`, envelope("cryptograms", {
    agent: supplied.agent, ...(supplied.agent_signature ? { agent_signature: supplied.agent_signature } : {}),
    encrypted_instruction: supplied.encrypted_instruction, transaction: transaction(pr, flow),
  }));
  const attrs = response?.data?.attributes;
  flow.cryptogramId = attrs?.cryptogram?.id ?? response?.data?.id ?? pr.id;
  flow.credential = ctx.maskCredential(attrs ?? {});
  flow.status = credentialUsable(attrs) ? "awaiting_payment_outcome" : "credential_unavailable";
  await saveFlow(ctx, flow);
  return flow.status === "credential_unavailable" ? pending(flow) : finishV2Payment(ctx, args, pr, flow);
}
