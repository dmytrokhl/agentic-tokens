import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareMockCard, preparationMessage, visaProvisioningStatus } from "../src/preparation.ts";

test("Visa provisioning uses tokenInfo.tokenStatus, preserves fixture status, and never invents an absent state", () => {
  for (const tokenStatus of ["ACTIVE", "INACTIVE", "SUSPENDED"]) {
    assert.equal(visaProvisioningStatus({ tokenInfo: { tokenStatus }, status: "fixture-status" }), tokenStatus);
  }
  assert.equal(visaProvisioningStatus({ status: "PENDING_STEP_UP" }), "PENDING_STEP_UP");
  for (const provision of [undefined, {}, { tokenInfo: {} }, { tokenInfo: { tokenStatus: "" } }, { tokenInfo: { tokenStatus: 123 } }]) {
    assert.equal(visaProvisioningStatus(provision), null);
  }
});

const config = {
  mockMode: "vic-v2-europe", mockSdk: { apiOrigin: "https://localhost:9446", vppOrigin: "https://localhost:9444", callbackOrigin: "https://localhost:9445" },
};
const card = { cardId: "synthetic-card", enrollment: { data: { id: "saved-token", attributes: { provision: { status: "PENDING_STEP_UP" } } } } };

test("preparation reuses selected token and sends explicit synthetic verification context", async () => {
  const calls = [];
  const session = { preparationState: "web_challenge_pending", destroy() {}, authenticate() { assert.fail("No ceremony"); } };
  const container = {};
  const factory = (options) => {
    calls.push(options);
    return { async startSession(target) { assert.equal(target, container); return session; } };
  };
  assert.equal(await prepareMockCard(card, config, container, "synthetic-token", factory), session);
  assert.equal(await prepareMockCard(card, config, container, "synthetic-token", factory), session);
  assert.equal(calls[0].tokenId, "saved-token");
  assert.notEqual(calls[0].clientRefId, calls[1].clientRefId);
  assert.equal(calls[0].preparationMode, "vic-v2-europe");
  assert.equal(calls[0].mockApiBase, "https://localhost:9446");
  assert.equal(calls[0].mockVppOrigin, "https://localhost:9444");
  assert.equal(calls[0].callbackUrl, "https://localhost:9445/");
  assert.equal(calls[0].authenticationAmount, "0");
  assert.equal(calls[0].merchantUrl, "https://localhost:4200");
  for (const key of ["assuranceData"]) assert.equal(Object.hasOwn(calls[0], key), false);
});

test("preparation cannot start without explicit mock configuration and a selected enrollment", async () => {
  let started = false;
  const factory = () => { started = true; return {}; };
  await assert.rejects(prepareMockCard(card, {}, {}, "token", factory));
  await assert.rejects(prepareMockCard(card, { ...config, mockSdk: { ...config.mockSdk, callbackOrigin: undefined } }, {}, "token", factory));
  await assert.rejects(prepareMockCard({ cardId: "new-card", enrollment: null }, config, {}, "token", factory));
  assert.equal(started, false);
});

test("provider states remain separate and unsupported context fails closed", () => {
  assert.match(preparationMessage("web_challenge_pending"), /before opening 3DS/);
  assert.match(preparationMessage("registration_ready"), /before passkey registration/);
  assert.match(preparationMessage("authentication_ready"), /before authentication/);
  assert.match(preparationMessage("otp_challenge_pending"), /before requesting a code/);
  assert.match(preparationMessage("unsupported_context"), /cannot continue/);
  assert.match(preparationMessage("secret-fido-data"), /cannot continue/);
  assert.equal(preparationMessage("secret-fido-data").includes("secret-fido-data"), false);
});
