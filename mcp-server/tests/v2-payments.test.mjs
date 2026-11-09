import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeV2Payment, v2InstructionOperation, validateV2Config } from "../src/v2-payments.js";

const evidence = [{ verificationEntity: "10", verificationMethod: "23", methodResults: {
  fidoAssertionData: { code: "actual-payment-evidence" }, identifier: "auth-id", dfpSessionId: "dfp" } }];
function fixture({ unavailable = false, sessionPhase = "PAYMENT", mockMode = true, unknownIssue = false } = {}) {
  const flows = new Map(); const requests = new Map(); const wallets = new Map(); const sessions = new Map(); const calls = [];
  requests.set("first", { id: "first", buyerId: "buyer", amount: 5, currency: "EUR", simulated: true, status: "pending", mandate: { quantity: 3, effectiveUntil: new Date(Date.now() + 600000).toISOString() } });
  wallets.set("buyer", { buyerId: "buyer", cardId: "card", tokenId: "saved-token", visaFlow: "v2", status: "enrolled" });
  sessions.set("binding-first", { phase: sessionPhase, cardId: "card", tokenId: "saved-token", buyerId: "buyer", assuranceData: evidence });
  const ctx = { visaFlow: "v2", visaAgent: "synthetic-eu-agent", mockMode, appBaseUrl: "https://localhost:4200", apiBaseUrl: "https://localhost:4200/api",
    defaultBuyerId: "buyer", defaultConsumerEmail: "buyer@example.test", defaultEnvironment: "local", openBrowser: () => false,
    maskCredential: (attrs) => ({ cryptogramId: attrs.cryptogram?.id ?? null, eci: attrs.eci ?? null }),
    requestStore: { get: async (key) => structuredClone(flows.get(key)), set: async (key, value) => flows.set(key, structuredClone(value)) },
    api: async (path, { method = "GET", body, allow404 = false } = {}) => {
      calls.push({ path, method, body: structuredClone(body) });
      const url = new URL(path, "https://localhost:4200");
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      if (url.pathname.startsWith("/payment-requests/")) {
        if (method === "PUT") requests.set(id, { ...requests.get(id), ...body });
        return structuredClone(requests.get(id));
      }
      if (url.pathname.startsWith("/subscriptions/")) {
        if (method === "POST") wallets.set(id, { ...wallets.get(id), ...body, buyerId: id });
        return { subscription: structuredClone(wallets.get(id)) };
      }
      if (url.pathname.startsWith("/merchant/cards/")) return { cards: [{ cardId: "card" }] };
      if (url.pathname.startsWith("/sessions/")) return structuredClone(sessions.get(id)) ?? (allow404 ? null : {});
      if (url.pathname === "/cryptograms") {
        if (unknownIssue) throw new Error("upstream-secret-must-not-return");
        return { data: { id: "instruction", attributes: { intent_id: "instruction", status: unavailable ? "CRYPTOGRAM_UNAVAILABLE" : "COMPLETED",
          eci: "05", ...(unavailable ? {} : { network_token: "synthetic-network-token", cryptogram: { value: "synthetic-value", type: "DSRP" } }) } } };
      }
      if (url.pathname === "/confirmations") return { data: { id: "confirmation", attributes: { status: body.data.attributes.instruction_completed ? "COMPLETED" : "ACTIVE" } } };
      if (url.pathname === "/intents" && method === "DELETE") return { data: { id: "instruction", attributes: { status: "CANCELLED" } } };
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    },
  };
  return { ctx, calls, requests, wallets, sessions, flows };
}

for (const bad of [{ visaAgent: undefined }, { apiBaseUrl: "https://remote.example/api" }, { visaFlow: "v1" }]) {
  test(`mock mode rejects missing agent or nonlocal configuration: ${JSON.stringify(bad)}`, () => {
    const { ctx } = fixture(); assert.throws(() => validateV2Config({ ...ctx, ...bad }));
  });
}

test("selected v2 reuses the saved token, forwards PAYMENT evidence, confirms after credential, and labels simulation", async () => {
  const f = fixture();
  const result = await authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx);
  assert.equal(result.status, "completed"); assert.equal(result.simulated, true);
  assert.match(result.nextStep, /No charge or publication/);
  const credential = f.calls.find((c) => c.path.startsWith("/cryptograms?"));
  const confirm = f.calls.find((c) => c.path.startsWith("/confirmations?"));
  assert.equal(new URL(credential.path, "https://local").searchParams.get("visaFlow"), "v2");
  assert.equal(credential.body.data.attributes.purchase_type, "PURCHASE_HITL");
  assert.deepEqual(credential.body.data.attributes.assurance_data, evidence);
  assert.equal(credential.body.data.attributes.agent, "synthetic-eu-agent");
  assert.equal(credential.body.data.attributes.agent_signature.input.tag, "credential-request");
  assert.equal(confirm.body.data.attributes.agent_signature.input.tag, "confirmation-request");
  assert.notEqual(credential.body.data.attributes.agent_signature.input.nonce, confirm.body.data.attributes.agent_signature.input.nonce);
  assert.equal(confirm.body.data.attributes.confirmation_data[0].transaction_reference_id, "first");
  assert.equal(confirm.body.data.attributes.instruction_completed, true);
  assert.equal(confirm.body.data.attributes.confirmation_data[0].mandate_status, "COMPLETED");
  assert.equal(result.cryptogramId, "instruction");
  assert.equal(f.calls.some((c) => c.path.includes("/agentic-tokens") || c.path.includes("/sites")), false);
  assert.ok(f.calls.indexOf(confirm) > f.calls.indexOf(credential));
  assert.equal(f.flows.get("first").assuranceData, undefined);
  const before = f.calls.filter((c) => c.path.startsWith("/cryptograms?")).length;
  await authorizeV2Payment({ paymentRequestId: "first" }, f.ctx);
  assert.equal(f.calls.filter((c) => c.path.startsWith("/cryptograms?")).length, before);
});

test("unavailable credential retains instruction ID and never confirms or recreates it", async () => {
  const f = fixture({ unavailable: true });
  const result = await authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx);
  assert.equal(result.status, "credential_unavailable"); assert.equal(result.intentId, "instruction");
  assert.equal(f.requests.get("first").intentId, "instruction");
  f.flows.clear();
  assert.equal((await authorizeV2Payment({ paymentRequestId: "first" }, f.ctx)).intentId, "instruction");
  assert.equal(f.calls.filter((c) => c.path.startsWith("/cryptograms?")).length, 1);
  assert.equal(f.calls.some((c) => c.path.startsWith("/confirmations?")), false);
});

for (const sessionPhase of ["REGISTER", "3DS", undefined]) {
  test(`phase ${sessionPhase} cannot replace actual PAYMENT evidence`, async () => {
    const f = fixture({ sessionPhase });
    if (sessionPhase === undefined) delete f.sessions.get("binding-first").phase;
    await assert.rejects(authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx), /PAYMENT evidence/);
    assert.equal(f.calls.some((c) => c.path.startsWith("/cryptograms?")), false);
  });
}

test("unknown credential outcome is not retried even after flow-state loss", async () => {
  const f = fixture({ unknownIssue: true });
  await assert.rejects(authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx), /outcome is unknown/);
  f.flows.clear();
  assert.equal((await authorizeV2Payment({ paymentRequestId: "first" }, f.ctx)).status, "state_recovery_required");
  assert.equal(f.calls.filter((c) => c.path.startsWith("/cryptograms?")).length, 1);
});

test("real v2 without a merchant payment outcome does not invent an approval", async () => {
  const f = fixture({ mockMode: false });
  f.ctx.getV2Inputs = async ({ operation }) => ({ agent: "synthetic-eu-agent", ...(operation === "credential" ? { encrypted_instruction: "external-opaque-instruction" } : {}) });
  const result = await authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx);
  assert.equal(result.status, "awaiting_payment_outcome");
  assert.equal(f.calls.some((c) => c.path.startsWith("/confirmations?")), false);
});

test("later credential uses active instruction and fresh inputs; cancellation blocks further retrieval", async () => {
  const f = fixture();
  f.requests.get("first").simulatedOutcome = "DECLINED";
  await authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx);
  f.requests.set("second", { id: "second", buyerId: "buyer", amount: 5, currency: "EUR", status: "pending", simulated: true, simulatedOutcome: "DECLINED" });
  const result = await v2InstructionOperation({ paymentRequestId: "second", buyerId: "buyer" }, f.ctx, "retrieve");
  assert.equal(result.intentId, "instruction");
  const draws = f.calls.filter((c) => c.path.startsWith("/cryptograms?"));
  assert.equal(new URL(draws[1].path, "https://local").searchParams.get("intentId"), "instruction");
  assert.equal(draws[1].body.data.attributes.assurance_data, undefined);
  assert.notEqual(draws[0].body.data.attributes.encrypted_instruction, draws[1].body.data.attributes.encrypted_instruction);
  f.requests.set("cancel", { id: "cancel", buyerId: "buyer", amount: 5, currency: "EUR", status: "pending", simulated: true });
  await v2InstructionOperation({ paymentRequestId: "cancel", buyerId: "buyer", assuranceData: evidence }, f.ctx, "cancel");
  assert.equal(f.wallets.get("buyer").status, "canceled");
  await assert.rejects(v2InstructionOperation({ paymentRequestId: "second", buyerId: "buyer" }, f.ctx, "retrieve"), /active Visa v2 instruction/);
});

test("the default mandate covers one purchase and completes after that approved transaction", async () => {
  const f = fixture(); delete f.requests.get("first").mandate;
  await authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx);
  const issued = f.calls.find((c) => c.path.startsWith("/cryptograms?")).body.data.attributes;
  const confirmed = f.calls.find((c) => c.path.startsWith("/confirmations?")).body.data.attributes;
  assert.equal(issued.mandates[0].quantity, 1);
  assert.ok(Date.parse(issued.mandates[0].effective_until) < Date.now() + 11 * 60000);
  assert.equal(confirmed.instruction_completed, true);
  assert.equal(confirmed.confirmation_data[0].mandate_status, "COMPLETED");
});

test("resuming a changed payment request cannot silently change mandate authority", async () => {
  const f = fixture(); f.sessions.clear();
  assert.equal((await authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx)).status, "waiting_for_authentication");
  f.requests.get("first").amount = 500;
  await assert.rejects(authorizeV2Payment({ paymentRequestId: "first" }, f.ctx), /scope changed/);
  assert.equal(f.calls.some((c) => c.path.startsWith("/cryptograms?")), false);
});

test("saved enrollment consumer and device facts survive token reuse and first credential", async () => {
  const f = fixture();
  Object.assign(f.wallets.get("buyer"), { consumerId: "existing-consumer", deviceId: "existing-device", cardholderVerification: "passkey", agenticEnrollmentRequired: false });
  await authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx);
  const issued = f.calls.find((c) => c.path.startsWith("/cryptograms?")).body.data.attributes;
  assert.equal(issued.consumer_id, "existing-consumer");
  assert.equal(f.flows.get("first").deviceId, "existing-device");
  assert.equal(f.wallets.get("buyer").consumerId, "existing-consumer");
  assert.equal(f.wallets.get("buyer").agenticEnrollmentRequired, false);
});

test("an agent handoff cannot replace the enrolled consumer identity", async () => {
  const f = fixture(); f.wallets.get("buyer").consumerId = "existing-consumer";
  f.ctx.getV2Inputs = async () => ({ agent: f.ctx.visaAgent, consumer_id: "different-consumer", encrypted_instruction: "opaque" });
  await assert.rejects(authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx), /Consumer identity/);
  assert.equal(f.calls.some((c) => c.path.startsWith("/cryptograms?")), false);
});

test("new enrollment retains provider consumer and verification facts without a legacy intent call", async () => {
  const f = fixture(); f.wallets.clear();
  f.sessions.get("binding-first").tokenId = "new-token";
  const original = f.ctx.api;
  f.ctx.api = async (path, options) => {
    if (path === "/cards/card/agentic-tokens") {
      f.calls.push({ path, ...options });
      return { data: { id: "new-token", attributes: { consumer_id: "new-consumer", device_id: "new-device",
        cardholder_verification: "passkey", agentic_enrollment_required: false } } };
    }
    return original(path, options);
  };
  await authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx);
  const enrolled = f.calls.find((c) => c.path === "/cards/card/agentic-tokens");
  assert.equal(enrolled.body.data.attributes.visa_flow, "v2");
  assert.match(enrolled.body.data.attributes.consumer_id, /^[a-f0-9]{32}$/);
  const issued = f.calls.find((c) => c.path.startsWith("/cryptograms?")).body.data.attributes;
  assert.equal(issued.consumer_id, "new-consumer");
  assert.equal(f.wallets.get("buyer").deviceId, "new-device");
  assert.equal(f.calls.some((c) => c.path.startsWith("/intents?")), false);
});

test("concurrent resumes issue one credential and one confirmation", async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    authorizeV2Payment({ paymentRequestId: 'first', cardId: 'card' }, f.ctx),
    authorizeV2Payment({ paymentRequestId: 'first', cardId: 'card' }, f.ctx),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(item => item.path.startsWith('/cryptograms?')).length, 1);
  assert.equal(f.calls.filter(item => item.path.startsWith('/confirmations?')).length, 1);
  assert.equal((await authorizeV2Payment({ paymentRequestId: 'first' }, f.ctx)).status, 'completed');
});

test("persistent claim rejection prevents every mutation and is not released by the rejected caller", async () => {
  const f = fixture();
  let releases = 0;
  f.ctx.requestStore.claim = async () => false;
  f.ctx.requestStore.release = async () => { releases++; };
  await assert.rejects(authorizeV2Payment({ paymentRequestId: 'first', cardId: 'card' }, f.ctx), /needs recovery/);
  assert.equal(releases, 0);
  assert.equal(f.calls.filter(item => item.method !== 'GET').length, 0);
});

test("the same buyer receives the same consumer identity on another card", async () => {
  const identities = [];
  for (const cardId of ['card-a', 'card-b']) {
    const f = fixture(); f.wallets.clear(); f.sessions.clear();
    const api = f.ctx.api;
    f.ctx.api = async (path, options) => {
      if (path === '/merchant/cards/buyer') return { cards: [{cardId}] };
      if (path === `/cards/${cardId}/agentic-tokens`) {
        identities.push(options.body.data.attributes.consumer_id);
        return { data: { id: `token-${cardId}`, attributes: { consumer_id: identities.at(-1) } } };
      }
      return api(path, options);
    };
    await authorizeV2Payment({ paymentRequestId: 'first', cardId }, f.ctx);
  }
  assert.equal(identities.length, 2);
  assert.equal(identities[0], identities[1]);
});

test("real MCP exposes exact sealing scope before requesting agent inputs", async () => {
  const f = fixture({ mockMode: false });
  const result = await authorizeV2Payment({ paymentRequestId: "first", cardId: "card" }, f.ctx);
  assert.equal(result.status, "awaiting_agent_inputs");
  assert.equal(result.agentHandoff.operation, "credential");
  assert.equal(result.agentHandoff.signatureTag, "credential-request");
  assert.equal(result.agentHandoff.encryptedInstructionPayload.mandates[0].declineThreshold.amount, "5.00");
  assert.equal(result.agentHandoff.encryptedInstructionPayload.transactionAmount.transactionCurrencyCode, "EUR");
  assert.equal(JSON.stringify(result).includes("actual-payment-evidence"), false);
  assert.equal(f.calls.some(c => c.path.startsWith("/cryptograms?")), false);
  const resumed = await authorizeV2Payment({ paymentRequestId: "first", agentInputs: {
    credential: { agent: f.ctx.visaAgent, encrypted_instruction: "agent-sealed-original-scope" },
  } }, f.ctx);
  assert.equal(resumed.status, "awaiting_payment_outcome");
  const submitted = f.calls.find(c => c.path.startsWith("/cryptograms?")).body.data.attributes;
  assert.deepEqual(submitted.mandates, result.agentHandoff.mandates);
  f.ctx.getPaymentOutcome = async () => ({ transaction_status: "DECLINED" });
  const confirmation = await authorizeV2Payment({ paymentRequestId: "first" }, f.ctx);
  assert.equal(confirmation.agentHandoff.operation, "confirmation");
  assert.equal(confirmation.agentHandoff.confirmation.instruction_completed, false);
  assert.equal(confirmation.agentHandoff.confirmation.confirmation_data[0].mandate_status, "ACTIVE");
  assert.equal(f.calls.some(c => c.path.startsWith("/confirmations?")), false);
  await authorizeV2Payment({ paymentRequestId: "first", agentInputs: { confirmation: { agent: f.ctx.visaAgent } } }, f.ctx);
  assert.deepEqual(f.calls.find(c => c.path.startsWith("/confirmations?")).body.data.attributes.confirmation_data,
    confirmation.agentHandoff.confirmation.confirmation_data);
  f.requests.set("later-handoff", { id: "later-handoff", buyerId: "buyer", amount: 3, currency: "EUR", status: "pending" });
  const later = await v2InstructionOperation({ paymentRequestId: "later-handoff", buyerId: "buyer" }, f.ctx, "retrieve");
  assert.equal(later.agentHandoff.encryptedInstructionPayload.mandates[0].declineThreshold.amount, "5.00");
  assert.equal(later.agentHandoff.encryptedInstructionPayload.transactionAmount.transactionAmount, "3.00");
  assert.deepEqual(later.agentHandoff.mandates, result.agentHandoff.mandates);
  f.ctx.getPaymentOutcome = undefined;
  const laterIssued = await v2InstructionOperation({ paymentRequestId: "later-handoff", buyerId: "buyer",
    agentInputs: { retrieve: { agent: f.ctx.visaAgent, encrypted_instruction: "agent-sealed-later-scope" } } }, f.ctx, "retrieve");
  assert.equal(laterIssued.status, "awaiting_payment_outcome");
  f.ctx.getPaymentOutcome = async () => ({ transaction_status: "APPROVED" });
  const laterConfirmed = await authorizeV2Payment({ paymentRequestId: "later-handoff",
    agentInputs: { confirmation: { agent: f.ctx.visaAgent } } }, f.ctx);
  assert.equal(laterConfirmed.status, "completed");
  assert.equal(f.calls.filter(c => c.path.startsWith("/cryptograms?")).length, 2);
});
