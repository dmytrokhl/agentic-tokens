import assert from "node:assert/strict";
import { test } from "node:test";
import { completeSandboxThreeDs, enrollEuropeCard, prepareSandboxCard, removeEuropeDeviceBinding, sandboxVerificationContext, sandboxCallbackUrl } from "../src/europe-sandbox.ts";

const config = { vaultEnv: "sandbox" };
const origin = "https://merchant.example.test";
const verification = { amount: "456.37", currencyCode: "978", merchantName: "Shop", merchantUrl: "https://shop.example/" };

test("sandbox callbacks default to this demo and reject unsafe or non-sandbox configuration", () => {
  assert.equal(sandboxCallbackUrl(config, origin), origin + "/visa-3ds-callback.html");
  assert.equal(sandboxCallbackUrl({ ...config, visaEuCallbackUrl: "https://callback.example.test/return" }, origin),
    "https://callback.example.test/return");
  for (const invalid of [{ vaultEnv: "live" }, { ...config, mockMode: "vic-v2-europe" },
    { ...config, visaEnvironment: null }, { ...config, visaEnvironment: "local" },
    ...["http://callback.example.test", "https://user:secret@callback.example.test", "https://callback.example.test/?code=x",
      "https://callback.example.test/#code"].map((visaEuCallbackUrl) => ({ ...config, visaEuCallbackUrl }))]) {
    assert.throws(() => sandboxCallbackUrl(invalid, origin));
  }
});

test("preparation uses the enrollment runtime's local or dev browser environment", async () => {
  for (const visaEnvironment of ["local", "dev"]) {
    let received;
    await prepareSandboxCard({ tokenId: "token" }, "buyer@example.test", { ...config, visaEnvironment }, "https://localhost:4201",
      {}, "access-token", (options) => { received = options; return { async startSession() { return { destroy() {} }; } }; }, () => "context", verification);
    assert.equal(received.environment, visaEnvironment);
    assert.equal(received.callbackUrl, "https://localhost:4201/visa-3ds-callback.html");
    assert.equal(Object.hasOwn(received, "mockApiBase"), false);
  }
});

test("Europe enrollment opts into v2 and exposes only identifiers and provider status", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ data: { id: "sandbox-token", attributes: {
      cardholder_verification: "passkey", provision: { tokenInfo: { tokenStatus: "INACTIVE" } }, opaque: "not-for-display",
    } } }));
  });
  const result = await enrollEuropeCard("sandbox/card", "buyer@example.test");
  assert.deepEqual(calls, [{ url: "/api/cards/sandbox%2Fcard/agentic-tokens", body: {
    data: { type: "agentic_tokens", attributes: { consumer_email: "buyer@example.test", visa_flow: "v2" } },
  } }]);
  assert.deepEqual(result, { tokenId: "sandbox-token", provisioningStatus: "INACTIVE", cardholderVerification: "passkey" });
});

test("failed or malformed enrollment cannot advance and does not expose raw upstream details", async (t) => {
  for (const [status, body] of [[403, { detail: "private-provider-data" }], [200, {}], [200, null]]) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status }));
    await assert.rejects(enrollEuropeCard("card", "buyer@example.test"), (error) => {
      assert.match(error.message, /enrollment failed/);
      assert.equal(error.message.includes("private-provider-data"), false);
      return true;
    });
  }
});

test("provider preparation obtains fresh sandbox browser context without purchase or agent inputs", async () => {
  const calls = [];
  const container = {};
  const prepared = { preparationState: "web_challenge_pending", destroy() {}, authenticate() { assert.fail("No automatic challenge"); } };
  const factory = (options) => {
    calls.push(options);
    return { async startSession(target) { assert.equal(target, container); return prepared; } };
  };
  const getCheckoutContext = () => "card:token:buyer";
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await prepareSandboxCard({ tokenId: "sandbox-token" }, "buyer@example.test", config, origin,
      container, "access-token", factory, getCheckoutContext, verification), prepared);
  }
  assert.equal(calls[0].tokenId, "sandbox-token");
  assert.equal(calls[0].environment, "sandbox");
  assert.equal(calls[0].preparationMode, "vic-v2-europe");
  assert.equal(calls[0].merchantUrl, verification.merchantUrl);
  assert.equal(calls[0].authenticationAmount, verification.amount);
  assert.equal(calls[0].callbackUrl, origin + "/visa-3ds-callback.html");
  assert.equal(calls[0].getCheckoutContext, getCheckoutContext);
  assert.notEqual(calls[0].clientRefId, calls[1].clientRefId);
  for (const key of ["mockApiBase", "mockVppOrigin", "agent_signature", "encrypted_instruction", "assuranceData"]) assert.equal(Object.hasOwn(calls[0], key), false);
});

test("3DS verification stops at registration context without a second ceremony or payment evidence", async () => {
  let calls = 0;
  const session = { preparationState: "web_challenge_pending", async authenticate() {
    calls += 1;
    session.preparationState = "registration_ready";
    return { status: "registration_ready" };
  } };
  await completeSandboxThreeDs(session);
  await assert.rejects(completeSandboxThreeDs(session));
  assert.equal(calls, 1);
  for (const preparationState of ["registration_ready", "authentication_ready", "awaiting_payment", "otp_challenge_pending"]) {
    await assert.rejects(completeSandboxThreeDs({ preparationState, authenticate() { assert.fail("Must stop"); } }));
  }
});

test("issuer failure, cancellation, and unsupported completion never count as successful 3DS", async () => {
  await assert.rejects(completeSandboxThreeDs({ preparationState: "web_challenge_pending", async authenticate() {
    throw new Error("Issuer declined verification");
  } }), /declined/);
  for (const result of [undefined, [], { status: "awaiting_payment" }]) {
    await assert.rejects(completeSandboxThreeDs({ preparationState: "web_challenge_pending", async authenticate() { return result; } }));
  }
});


test("verification requires explicit amount and merchant context before browser or API calls", () => {
  assert.deepEqual(sandboxVerificationContext("456.37", "978", " Shop ", "https://shop.example"), verification);
  for (const values of [["", "978", "Shop", origin], ["12345678", "978", "Shop", origin], ["5", "EUR", "Shop", origin], ["5", "978", "", origin], ["5", "978", "Shop", "https://user:secret@shop.example"], ["5", "978", "Shop", "http://shop.example"]]) assert.throws(() => sandboxVerificationContext(...values));
});

test("explicit new binding is optional and starts a fresh session", async () => {
  for (const requested of [false, true]) {
    let received;
    await prepareSandboxCard({ tokenId: "token" }, "buyer@example.test", config, origin,
      {}, "access-token", (options) => { received = options; return { async startSession() { return { destroy() {} }; } }; },
      () => "context", verification, requested);
    assert.equal(received.startDeviceBinding, requested);
  }
});

test("registration-only preparation is explicit and does not change purchase sessions", async () => {
  for (const registrationOnly of [false, true]) {
    let received;
    await prepareSandboxCard({ tokenId: "token" }, "buyer@example.test", config, origin,
      {}, "access-token", (options) => { received = options; return { async startSession() { return { destroy() {} }; } }; },
      () => "context", verification, true, registrationOnly);
    assert.equal(received.registrationOnly, registrationOnly);
    assert.equal(received.startDeviceBinding, true);
  }
});

test("enrollment retains the device ID for removal", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { id: "token", attributes: { device_id: "device-123" } } }));
  assert.equal((await enrollEuropeCard("card", "buyer@example.test")).deviceId, "device-123");
});

test("device removal uses DELETE without a body and requires Visa's explicit result", async (t) => {
  for (const result of ["APPROVED", "CHALLENGE", "REJECTED"]) {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push({ url, options });
      return Response.json({ data: { attributes: { result } } });
    });
    assert.equal(await removeEuropeDeviceBinding("token/one", " device-123 "), result);
    assert.equal(calls[0].url, "/api/device-bindings?tokenId=token%2Fone&deviceId=device-123");
    assert.equal(calls[0].options.method, "DELETE");
    assert.equal(Object.hasOwn(calls[0].options, "body"), false);
  }
});

test("failed, malformed, and ambiguous device removal never reports approval", async (t) => {
  for (const [status, body] of [[200, null], [200, {}], [200, { data: { attributes: { status: "APPROVED" } } }],
    [200, { data: { attributes: { result: "OTHER" } } }], [403, { detail: "private-visa-response" }],
    [500, { data: { attributes: { result: "APPROVED" } } }]]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(body, { status }));
    await assert.rejects(removeEuropeDeviceBinding("token", "device"), (error) => {
      assert.equal(error.message.includes("private-visa-response"), false);
      assert.match(error.message, /not confirmed/);
      return true;
    });
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private transport detail"); });
  await assert.rejects(removeEuropeDeviceBinding("token", "device"), /outcome unavailable/);
});

test("invalid device removal inputs cannot send an API request", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Invalid inputs must not reach the API"));
  for (const [token, device] of [["", "device"], ["token", ""], ["token", "../other"], ["token", "x".repeat(25)]]) {
    await assert.rejects(removeEuropeDeviceBinding(token, device));
  }
});
