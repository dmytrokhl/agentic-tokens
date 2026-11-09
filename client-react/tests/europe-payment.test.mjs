import assert from "node:assert/strict";
import { test } from "node:test";
import { continueEuropeSession, createEuropePurchase, credentialHandoff, credentialSummary, confirmationSummary, EuropeOutcomeUnknown,
  openSourceConsumer, parseAgentInputs, purchaseMandates, purchaseTransaction, requirePaymentEvidence, submitEuropeOperation } from "../src/europe-payment.ts";

const purchase = () => createEuropePurchase("5", "EUR", "Test merchant", "https://merchant.example.test/", "2", "2099-01-01T00:00:00Z");
const payment = [{ verificationEntity: "10", verificationMethod: "23", methodResults: {
  identifier: "synthetic-id", dfpSessionId: "synthetic-dfp", fidoAssertionData: { code: "synthetic-payment" },
} }];

test("registration-only completion advances to purchase creation without PAYMENT evidence", async () => {
  const result = await continueEuropeSession({ preparationState: "registration_ready", destroy() {},
    async authenticate() { return { status: "registration_complete" }; } });
  assert.deepEqual(result, { phase: "prepared" });
  assert.equal(Object.hasOwn(result, "evidence"), false);
});

test("a purchase retains one immutable mandate, transaction, and matching agent encryption scope", () => {
  const scope = purchase();
  const handoff = credentialHandoff(scope, "credential", "consumer");
  assert.equal(handoff.mandates[0].mandate_id, scope.mandateId);
  assert.equal(handoff.transaction.mandate_id, scope.mandateId);
  assert.equal(handoff.transaction.transaction_reference_id, scope.referenceId);
  assert.equal(handoff.encryptedInstructionPayload.mandates[0].mandateId, scope.mandateId);
  assert.deepEqual(handoff.encryptedInstructionPayload.transactionAmount, { transactionAmount: "5.00", transactionCurrencyCode: "EUR" });
  assert.equal(handoff.encryptedInstructionPayload.mandates[0].quantity, "2");
  assert.equal(handoff.signatureTag, "credential-request");
  assert.notEqual(scope.referenceId, purchase().referenceId);
  assert.equal(JSON.stringify(handoff).includes("assurance"), false);
  assert.equal(Object.hasOwn(handoff, "agent_signature"), false);
  for (const args of [["0", "EUR"], ["NaN", "EUR"], ["1.234", "EUR"], ["5", "INVALID"]]) {
    assert.throws(() => createEuropePurchase(...args, "Merchant", "https://merchant.example.test", "1", "2099-01-01T00:00:00Z"));
  }
});

test("3DS, registration and PAYMENT require separate actions and only PAYMENT can return purchase evidence", async () => {
  const session = { preparationState: "web_challenge_pending", async authenticate() {
    const result = { web_challenge_pending: "registration_ready", registration_ready: "awaiting_payment", awaiting_payment: "complete" }[session.preparationState];
    session.preparationState = result;
    return result === "complete" ? payment : { status: result };
  } };
  assert.deepEqual(await continueEuropeSession(session), { phase: "registration_ready" });
  assert.deepEqual(await continueEuropeSession(session), { phase: "awaiting_payment" });
  assert.deepEqual(await continueEuropeSession(session), { phase: "complete", evidence: payment });
  await assert.rejects(continueEuropeSession(session));
  await assert.rejects(continueEuropeSession({ preparationState: "registration_ready", async authenticate() { return payment; } }));
  for (const value of [[], [{ verificationEntity: "02" }], [{ ...payment[0], verificationEntity: "11" }],
    [{ ...payment[0], methodResults: { identifier: "registration" } }]]) assert.throws(() => requirePaymentEvidence(value));
});

test("credential input rejects keys, scope overrides, consumer mismatches and wrong signature purposes", () => {
  const inputs = { agent: "enabled-agent", encrypted_instruction: "synthetic-sealed-instruction", consumer_id: "same-consumer",
    agent_signature: { input: { tag: "credential-request" }, value: "synthetic-signature" } };
  assert.deepEqual(parseAgentInputs(JSON.stringify(inputs), "credential", "same-consumer"), inputs);
  assert.throws(() => parseAgentInputs(JSON.stringify(inputs), "credential", "other-consumer"));
  for (const field of ["private_key", "assurance_data", "mandates", "transaction"]) {
    assert.throws(() => parseAgentInputs(JSON.stringify({ ...inputs, [field]: "must-not-forward" }), "credential"));
  }
  assert.throws(() => parseAgentInputs(JSON.stringify(inputs), "confirmation"));
  assert.throws(() => parseAgentInputs(JSON.stringify({ agent: "enabled-agent" }), "credential"));
  assert.throws(() => parseAgentInputs("null", "credential"));
});

test("the first credential uses the v2 proxy and no earlier intent call; later calls preserve provider-native IDs", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return Response.json({ data: { id: "native-id", attributes: { intent_id: "native-intent", status: "COMPLETED" } } });
  });
  const scope = purchase();
  const attributes = { agent: "enabled-agent", encrypted_instruction: "synthetic-sealed", assurance_data: payment,
    mandates: purchaseMandates(scope), transaction: purchaseTransaction(scope), purchase_type: "PURCHASE_HITL" };
  await submitEuropeOperation("credential", "card/value", "token/value", attributes);
  assert.deepEqual(calls[0], { url: "/api/cryptograms?visaFlow=v2&cardId=card%2Fvalue&tokenId=token%2Fvalue",
    method: "POST", body: { data: { type: "cryptograms", attributes } } });
  await submitEuropeOperation("confirmation", "card", "token", { confirmation_data: [] }, "native-intent");
  assert.match(calls[1].url, /^\/api\/confirmations\?.*intentId=native-intent$/);
});

test("a network error or incomplete provider response requires reconciliation and never becomes a completed operation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private-upstream-material"); });
  await assert.rejects(submitEuropeOperation("credential", "c", "t", {}), EuropeOutcomeUnknown);
  for (const response of [() => new Response("{}", { status: 502 }), () => Response.json({ data: { id: "instruction" } })]) {
    t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(submitEuropeOperation("credential", "c", "t", {}), (error) => {
      assert.ok(error instanceof EuropeOutcomeUnknown);
      assert.equal(error.message.includes("private-upstream-material"), false);
      return true;
    });
  }
});

test("credential summaries mask the network token, omit crypto and retain unavailable instruction IDs", () => {
  const result = credentialSummary({ status: "COMPLETED", intent_id: "instruction", network_token: "synthetic-network-1234",
    cryptogram: { type: "TAVV", value: "private-cryptogram" }, assurance_data: payment, eci: "05" });
  assert.equal(result.usable, true); assert.equal(result.tokenLast4, "1234");
  assert.equal(JSON.stringify(result).includes("private-cryptogram"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-network"), false);
  const unavailable = credentialSummary({ status: "CRYPTOGRAM_UNAVAILABLE", intent_id: "keep-instruction" });
  assert.equal(unavailable.usable, false); assert.equal(unavailable.intentId, "keep-instruction");
});

 test("open-source first credentials include inline consumer enrollment through the proxy", async (t) => {
  const consumer = openSourceConsumer(" shopper@example.com ", " shopper ", "de", "EN");
  assert.deepEqual(consumer, { username: "shopper", email: "shopper@example.com", country_code: "DE", language_code: "en" });
  let sent;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent = JSON.parse(options.body).data.attributes;
    return Response.json({ data: { id: "native-id", attributes: { intent_id: "native-intent", status: "COMPLETED" } } });
  });
  await submitEuropeOperation("credential", "card", "token", { agent: "open-source", consumer_id: "existing-id", consumer });
  assert.deepEqual(sent.consumer, consumer);
  assert.equal(sent.consumer_id, "existing-id");
  for (const args of [["shopper@example.com", "shopper", "", "en"], ["shopper@example.com", "shopper", "DE", ""],
    ["shopper@example.com", "", "DE", "en"], ["invalid", "shopper", "DE", "en"]]) {
    assert.throws(() => openSourceConsumer(...args));
  }
});

test("successful confirmations without instruction status remain accepted", async (t) => {
  for (const status of [undefined, null, "ACTIVE", "COMPLETED"]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: {
      id: "instruction-id", type: "confirmations", attributes: { intent_id: "instruction-id", ...(status === undefined ? {} : { status }) },
    } }, { status: 201 }));
    const result = await submitEuropeOperation("confirmation", "card", "token", {}, "instruction-id");
    assert.deepEqual(confirmationSummary(result), { accepted: true, instructionStatus: status ?? null });
  }
});
