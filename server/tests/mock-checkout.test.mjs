import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { installMockCheckoutRoutes } from "../mock-checkout.js";
import { installMockMerchantRoutes } from "../mock-merchant.js";

const evidence = [{ verificationEntity: "10", verificationMethod: "23", methodResults: {
  identifier: "payment-identifier", dfpSessionId: "fingerprint", fidoAssertionData: { code: "synthetic-payment-only" },
} }];

test("manual checkout shares credential orchestration, defers confirmation, and supports later deferred confirmation then cancellation", async (t) => {
  const app = express(); app.use(express.json()); installMockMerchantRoutes(app);
  const calls = [];
  app.get("/api/merchant/cards/:buyer", (_req, res) => res.json({ cards: [{ cardId: "card" }] }));
  app.post("/api/merchant/cards/:buyer", (_req, res) => res.json({ saved: true }));
  app.post("/api/cryptograms", (req, res) => {
    calls.push({ operation: "credential", query: req.query, body: req.body });
    res.status(201).json({ data: { id: "instruction", attributes: { intent_id: "instruction", status: "COMPLETED",
      network_token: "synthetic-network-token-not-for-browser", last4: "1000", eci: "05",
      cryptogram: { id: `credential-${calls.length}`, type: "DTVV", value: "synthetic-credential-not-for-browser" } } } });
  });
  app.post("/api/confirmations", (req, res) => {
    calls.push({ operation: "confirmation", body: req.body });
    res.status(201).json({ data: { id: "confirmation", attributes: { status: req.body.data.attributes.instruction_completed ? "COMPLETED" : "ACTIVE" } } });
  });
  app.delete("/api/intents", (req, res) => {
    calls.push({ operation: "cancel", body: req.body });
    res.json({ data: { id: "instruction", attributes: { status: "CANCELLED" } } });
  });
  let base;
  const api = async (path, { method = "GET", body, allow404 = false } = {}) => {
    const response = await fetch(`${base}/api${path}`, { method,
      headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error("Unexpected merchant failure");
    return response.json();
  };
  const card = { cardId: "card", lastFour: "1000", brand: "VISA", enrollment: { data: { id: "saved-token", attributes: {
    consumer_id: "saved-consumer", device_id: "saved-device", cardholder_verification: "passkey", agentic_enrollment_required: false,
  } } } };
  installMockCheckoutRoutes(app, { mockConfig: { merchantOrigin: "https://localhost:4200" }, visaAgent: "synthetic-eu-agent",
    cards: new Map([["card", card]]), merchantApi: api });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  base = `http://127.0.0.1:${server.address().port}`;
  const buyerId = "manual-card";
  const create = (id) => api("/payment-requests", { method: "POST", body: { id, buyerId, amount: 5, currency: "EUR" } });
  const act = async (operation, id, extra = {}) => {
    const response = await fetch(`${base}/api/mock/checkout`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, paymentRequestId: id, buyerId, cardId: "card", ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  await create("first");
  assert.equal((await act("confirm", "first", { simulatedOutcome: "APPROVED" })).status, 400);
  const waiting = await act("authorize", "first");
  assert.equal(waiting.body.status, "waiting_for_authentication");
  assert.equal(new URL(waiting.body.binding.url).searchParams.get("tokenId"), "saved-token");
  assert.equal(calls.length, 0);
  await api("/sessions/binding-first", { method: "POST", body: { buyerId, cardId: "card", tokenId: "saved-token", phase: "PAYMENT", assuranceData: evidence } });
  const issued = await act("authorize", "first");
  assert.equal(issued.body.status, "awaiting_payment_outcome");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.data.attributes.consumer_id, "saved-consumer");
  assert.deepEqual(calls[0].body.data.attributes.assurance_data, evidence);
  assert.equal(JSON.stringify(issued).includes("synthetic-network-token-not-for-browser"), false);
  assert.equal(JSON.stringify(issued).includes("synthetic-credential-not-for-browser"), false);
  const firstConfirmed = await act("confirm", "first", { simulatedOutcome: "DECLINED" });
  assert.equal(firstConfirmed.body.instructionStatus, "ACTIVE");
  assert.equal(calls.at(-1).body.data.attributes.confirmation_data[0].transaction_status, "DECLINED");
  await create("later");
  const later = await act("retrieve", "later");
  assert.equal(later.body.status, "awaiting_payment_outcome");
  assert.equal(calls.at(-1).operation, "credential");
  assert.equal(calls.at(-1).query.intentId, "instruction");
  assert.equal(calls.at(-1).body.data.attributes.assurance_data, undefined);
  const laterConfirmed = await act("confirm", "later", { simulatedOutcome: "DECLINED" });
  assert.equal(laterConfirmed.status, 200);
  assert.equal(laterConfirmed.body.instructionStatus, "ACTIVE");
  await create("cancel");
  assert.equal((await act("cancel", "cancel", { evidenceSessionId: "binding-first" })).body.status, "canceled");
  assert.deepEqual(calls.at(-1).body.data.attributes.assurance_data, evidence);
  await create("blocked");
  assert.equal((await act("retrieve", "blocked")).status, 400);
});

test("manual orchestration endpoints are absent outside explicit local mock configuration", async (t) => {
  const app = express(); app.use(express.json()); installMockCheckoutRoutes(app, { mockConfig: null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mock/checkout`, { method: "POST" });
  assert.equal(response.status, 404);
});

test("default HTTP transport accepts a successful 204 cancellation without reporting an unknown outcome", async (t) => {
  const app = express(); app.use(express.json()); installMockMerchantRoutes(app);
  let cancellations = 0;
  app.delete("/api/intents", (_req, res) => { cancellations += 1; res.status(204).end(); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  installMockCheckoutRoutes(app, { mockConfig: { merchantOrigin: "https://localhost:4200" },
    visaAgent: "synthetic-eu-agent", port });
  const base = `http://127.0.0.1:${port}/api`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const buyerId = "manual-no-body";
  await post("/payment-requests", { id: "cancel-204", buyerId, amount: 5, currency: "EUR" });
  await post(`/subscriptions/${buyerId}`, { buyerId, cardId: "card", tokenId: "token", intentId: "instruction",
    visaFlow: "v2", status: "active", instructionStatus: "ACTIVE", mandateQuantity: 1, mandateUsed: 0,
    authorizedPerChargeAmount: 5, currency: "EUR" });
  await post("/sessions/binding-original", { buyerId, cardId: "card", tokenId: "token", phase: "PAYMENT", assuranceData: evidence });
  const response = await post("/mock/checkout", { operation: "cancel", paymentRequestId: "cancel-204", buyerId,
    evidenceSessionId: "binding-original" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "canceled");
  assert.equal(result.result, null);
  assert.equal(cancellations, 1);
  const wallet = await (await fetch(`${base}/subscriptions/${buyerId}`)).json();
  assert.equal(wallet.subscription.status, "canceled");
  assert.equal(wallet.subscription.instructionStatus, "CANCELLED");
});

test("a new unavailable instruction does not inherit an older wallet instruction's ACTIVE status", async (t) => {
  const app = express(); app.use(express.json()); installMockMerchantRoutes(app);
  app.get("/api/merchant/cards/:buyer", (_req, res) => res.json({ cards: [{ cardId: "card" }] }));
  app.post("/api/merchant/cards/:buyer", (_req, res) => res.json({ saved: true }));
  app.post("/api/cryptograms", (_req, res) => res.status(201).json({ data: { id: "new-instruction", attributes: {
    intent_id: "new-instruction", status: "CRYPTOGRAM_UNAVAILABLE", consumer_id: "consumer",
  } } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  installMockCheckoutRoutes(app, { mockConfig: { merchantOrigin: "https://localhost:4200" }, visaAgent: "synthetic-eu-agent", port,
    cards: new Map([["card", { cardId: "card", lastFour: "1000", brand: "VISA" }]]) });
  const base = `http://127.0.0.1:${port}/api`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const buyerId = "manual-unavailable";
  await post("/payment-requests", { id: "new", buyerId, amount: 5, currency: "EUR" });
  await post(`/subscriptions/${buyerId}`, { buyerId, cardId: "card", tokenId: "token", intentId: "older-instruction",
    visaFlow: "v2", status: "active", instructionStatus: "ACTIVE", mandateQuantity: 1, mandateUsed: 0,
    authorizedPerChargeAmount: 5, currency: "EUR" });
  await post("/sessions/binding-new", { buyerId, cardId: "card", tokenId: "token", phase: "PAYMENT", assuranceData: evidence });
  const response = await post("/mock/checkout", { operation: "authorize", paymentRequestId: "new", buyerId, cardId: "card" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "credential_unavailable");
  assert.equal(result.intentId, "new-instruction");
  assert.equal(result.instructionStatus, null);
  const wallet = await (await fetch(`${base}/subscriptions/${buyerId}`)).json();
  assert.equal(wallet.subscription.intentId, "older-instruction");
  assert.equal(wallet.subscription.instructionStatus, "ACTIVE");
});
