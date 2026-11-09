import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/vgs-agentic-auth.js", import.meta.url), "utf8")
  .replace("export { VgsAgenticAuth, VgsAgenticAuthError };", "globalThis.SDK = VgsAgenticAuth;");
const origin = "https://localhost:9444";
const web = { method: "APP-TO-APP", platformType: "WEB", source: "https://localhost:9444/issuer?existing=1", identifier: "web", requestPayload: "" };
const otp = { method: "OTPSMS", identifier: "sms" };
const copy = (value) => JSON.parse(JSON.stringify(value));

function harness(attrs, { browserOrigin = "https://localhost:4200", invalidMessages = false,
  sessionResult = "COMPLETE", dropType, responses, popupBlocked = false, popupFailure, paymentAssurance = { identifier: "id", fidoBlob: "synthetic-payment" }, sessionContext = { secureToken: "synthetic-session" } } = {}) {
  const listeners = new Set();
  const commands = [];
  const requests = [];
  const frames = [];
  const popups = [];
  let now = 1_000_000;
  let identity = 0;
  let checkout = "buyer-card-cart";
  const window = {
    location: { origin: browserOrigin, hostname: new URL(browserOrigin).hostname },
    addEventListener: (_type, handler) => listeners.add(handler),
    removeEventListener: (_type, handler) => listeners.delete(handler),
    open() {
      if (popupBlocked) return null;
      const popup = { closed: false, close() { this.closed = true; },
        postMessage(command, targetOrigin) {
          commands.push({ ...copy(command), targetOrigin, popup: true });
          if (command.type === "AUTHENTICATE") queueMicrotask(() => emit({ contentWindow: popup }, popupFailure || "AUTH_COMPLETE", {
            requestID: "popup-attempt", result: "COMPLETE", assuranceData: paymentAssurance,
          }));
        },
      };
      let href = "about:blank";
      popup.location = { get href() { return href; }, set href(value) {
        href = value;
        if (value.includes("/vts-auth/authenticate")) queueMicrotask(() => emit({ contentWindow: popup }, "AUTH_READY", { requestID: "popup-attempt" }));
      } };
      popups.push(popup);
      return popup;
    },
  };
  function emit(frame, type, extra = {}) {
    if (type === dropType) return;
    const event = { origin, source: frame.contentWindow, data: { type, requestID: "attempt", ...extra } };
    if (invalidMessages) {
      for (const bad of [
        { ...event, origin: "https://attacker.example" },
        { ...event, source: {}, data: { ...event.data, requestID: "other-window" } },
        ...(type === "AUTH_READY" ? [] : [{ ...event, data: { ...event.data, requestID: "stale-attempt", sessionContext: { secureToken: "wrong" } } }]),
      ]) for (const listener of [...listeners]) listener(bad);
    }
    for (const listener of [...listeners]) listener(event);
  }
  const container = {
    appendChild(frame) {
      frames.push(frame);
      queueMicrotask(() => emit(frame, "AUTH_READY"));
    },
  };
  const document = {
    body: container,
    createElement() {
      const frame = { style: {}, remove() { this.removed = true; } };
      frame.contentWindow = {
        postMessage(command, targetOrigin) {
          commands.push({ ...copy(command), targetOrigin });
          if (command.type === "CREATE_AUTH_SESSION") {
            // Respond synchronously to check that the listener exists before the command.
            emit(frame, "AUTH_SESSION_CREATED", {
              result: sessionResult,
              sessionContext,
              browserData: { browserLanguage: "en" }, dfpSessionID: "synthetic-dfp",
            });
          }
          if (command.type === "AUTHENTICATE") queueMicrotask(() => emit(frame, "AUTH_COMPLETE", {
            result: "COMPLETE", assuranceData: { identifier: "payment", fidoBlob: "synthetic-evidence" },
          }));
        },
      };
      return frame;
    },
  };
  const context = vm.createContext({ window, document, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => `synthetic-attempt-${++identity}` },
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      const response = responses ? responses[requests.length - 1] : attrs;
      return { ok: true, json: async () => ({ data: { attributes: response } }) };
    },
  });
  vm.runInContext(source, context);
  const defaults = {
    tokenId: "selected-token", environment: "local", consumerEmail: "synthetic@example.test",
    preparationMode: "vic-v2-europe", mockVppOrigin: origin, mockApiBase: "https://localhost:9446", timeout: 50,
    clientRefId: "reference",
  };
  function callback(data = {}, overrides = {}) {
    const popup = popups.at(-1);
    const callback = new URL(new URL(popup.location.href).searchParams.get("wpcallback"));
    const event = { origin: callback.origin, source: popup, data: {
      type: "vgs:3ds-result", attempt_id: callback.searchParams.get("attempt_id"),
      stepupresponse: "approved", stepupauthcode: "synthetic-code", ...data,
    }, ...overrides };
    for (const listener of [...listeners]) listener(event);
  }
  return { create: (options = {}) => new context.SDK({ ...defaults, ...options }), frames, popups, commands, requests, listeners,
    callback, advanceTime: (ms) => { now += ms; }, changeCheckout: (value) => { checkout = value; },
    continuation: { checkoutContext: checkout, getCheckoutContext: () => checkout, callbackUrl: "https://localhost:9445/visa-3ds-callback/" },
  };
}

for (const attributes of [{ status: "CHALLENGE" }, { result: "CHALLENGE" }]) {
  test(`preparation preserves WEB fields and stops before all ceremonies (${Object.keys(attributes)[0]})`, async () => {
    const h = harness({ ...attributes, stepUpRequest: [otp, web] });
    const session = await h.create().startSession();
    assert.equal(session.preparationState, "web_challenge_pending");
    assert.equal(session.needsWebChallenge, true);
    assert.equal(session.needsOtp, false);
    assert.deepEqual(copy(session.webChallenge), web);
    assert.equal(h.frames[0].width, "0");
    assert.equal(h.frames[0].allow, "payment *; publickey-credentials-get *; publickey-credentials-create *");
    assert.deepEqual(h.commands.map((c) => c.type), ["CREATE_AUTH_SESSION"]);
    assert.equal(h.commands[0].client.id, new URL(h.frames[0].src).searchParams.get("apiKey"));
    assert.equal(h.requests.length, 1);
    assert.match(h.requests[0].url, /selected-token\/device-attestations$/);
    assert.deepEqual(h.requests[0].body.data.attributes, {
      browserData: { browserLanguage: "en" }, sessionContext: { secureToken: "synthetic-session" },
      client_ref_id: "reference", consumer_email: "synthetic@example.test",
      auth_type: "AUTHENTICATE", reason_code: "PAYMENT", preparation: true, consumer_locale: "en_US",
    });
    await assert.rejects(session.authenticate(), { code: "preparation_continuation_unavailable" });
    await assert.rejects(session.requestOtp(otp), /Cannot call requestOtp/);
    await assert.rejects(session.submitOtp("123456"), /Cannot call submitOtp/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.commands.length, 1);
    session.destroy();
    session.destroy();
    assert.deepEqual(h.commands.map((c) => c.type), ["CREATE_AUTH_SESSION", "CLOSE_AUTH_SESSION"]);
    assert.equal(h.listeners.size, 0);
  });
}

for (const action of ["AUTHENTICATE", "REGISTER"]) {
  test(`preparation retains distinct ${action} context without producing payment evidence`, async () => {
    const h = harness({ authenticationContext: { action, endpoint: "opaque", payload: "challenge", identifier: "id" } });
    const session = await h.create({ authenticationAmount: "0", currencyCode: "978", merchantName: "Example" }).startSession();
    assert.equal(session.authenticationAction, action);
    assert.equal(session.preparationState, action === "REGISTER" ? "registration_ready" : "authentication_ready");
    assert.equal(session.needsWebChallenge, false);
    assert.equal(session.needsOtp, false);
    assert.equal(h.requests[0].body.data.attributes.authentication_amount, "0");
    assert.equal(h.requests[0].body.data.attributes.currency_code, "978");
    assert.equal(h.requests[0].body.data.attributes.merchant_name, "Example");
    await assert.rejects(session.authenticate(), { code: "preparation_continuation_unavailable" });
    assert.equal(h.commands.length, 1);
    session.destroy();
  });
}

for (const method of [
  { ...web, platformType: "ANDROID" }, { ...web, method: "OTPSMS" },
  { ...web, method: "OTHER" }, { ...web, platformType: undefined },
]) {
  test(`WEB dispatch requires both exact fields: ${method.method}/${method.platformType}`, async () => {
    const h = harness({ status: "CHALLENGE", stepUpRequest: [method] });
    const session = await h.create().startSession();
    assert.equal(session.needsWebChallenge, false);
    assert.equal(session.webChallenge, null);
    assert.equal(session.needsOtp, method.method === "OTPSMS");
    assert.equal(session.preparationState, method.method === "OTPSMS" ? "otp_challenge_pending" : "unsupported_challenge");
    session.destroy();
  });
}

test("preparation accepts only its provider window, origin, and current requestID", async () => {
  const h = harness({ authenticationContext: { action: "AUTHENTICATE" } }, { invalidMessages: true });
  const session = await h.create().startSession();
  assert.equal(h.requests[0].body.data.attributes.sessionContext.secureToken, "synthetic-session");
  session.destroy();
});

for (const incomplete of [{ sessionResult: "INCOMPLETE" }, { sessionContext: {} }]) {
  test(`incomplete browser context stops before the API: ${JSON.stringify(incomplete)}`, async () => {
    const h = harness({}, incomplete);
    await assert.rejects(h.create().startSession(), /Incomplete browser session context/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.frames[0].removed, true);
    assert.equal(h.listeners.size, 0);
  });
}

test("a new preparation obtains fresh browser context instead of saving the session", async () => {
  const h = harness({ authenticationContext: { action: "AUTHENTICATE" } });
  const sdk = h.create();
  const first = await sdk.startSession();
  first.destroy();
  const second = await sdk.startSession();
  assert.equal(h.frames.length, 2);
  assert.equal(h.requests.length, 2);
  assert.equal(h.commands.filter((c) => c.type === "CREATE_AUTH_SESSION").length, 2);
  second.destroy();
});

for (const options of [
  { environment: "sandbox" }, { mockVppOrigin: "https://provider.example" },
  { mockVppOrigin: `${origin}/` }, { mockVppOrigin: `${origin}/path` },
  { mockVppOrigin: `${origin}?key=value` }, { mockVppOrigin: "https://user:pass@localhost:9444" },
  { mockVppOrigin: "javascript:alert(1)" }, { mockVppOrigin: "" },
  { mockApiBase: "https://api.example" }, { mockApiBase: "" }, { mockApiBase: null }, { mockVppOrigin: undefined },
]) {
  test(`mock configuration rejects a nonlocal or inexact origin: ${JSON.stringify(options)}`, () => {
    assert.throws(() => harness({}).create(options), /Mock/);
  });
}

test("mock configuration rejects a remote merchant", () => {
  assert.throws(() => harness({}, { browserOrigin: "https://merchant.example" }).create(), /loopback/);
});

test("unknown preparation mode fails before any browser or API operation", () => {
  assert.throws(() => harness({}).create({ preparationMode: "europe" }), /Unknown preparationMode/);
});

test("legacy passkey flow keeps default purchase inputs and returns assurance data", async () => {
  const h = harness({ authenticationContext: { action: "AUTHENTICATE" } });
  const session = await h.create({ preparationMode: undefined }).startSession();
  assert.equal(h.requests[0].body.data.attributes.preparation, undefined);
  assert.equal(h.requests[0].body.data.attributes.authentication_amount, "100");
  assert.equal(h.requests[0].body.data.attributes.currency_code, "840");
  assert.equal(h.commands[0].client, undefined);
  assert.equal(h.frames[0].allow, "publickey-credentials-get *; publickey-credentials-create *");
  const assurance = await session.authenticate();
  assert.equal(assurance[0].methodResults.fidoAssertionData.code, "synthetic-evidence");
  assert.deepEqual(h.commands.map((c) => c.type), ["CREATE_AUTH_SESSION", "AUTHENTICATE", "CLOSE_AUTH_SESSION"]);
  session.destroy();
});

test("legacy OTP delivery and submission remain available", async () => {
  const h = harness({ status: "CHALLENGE", stepUpRequest: [otp], passkey_required: false });
  const session = await h.create({ preparationMode: undefined }).startSession();
  assert.equal(session.needsOtp, true);
  await session.requestOtp(otp);
  await session.submitOtp("123456");
  assert.deepEqual(copy(await session.authenticate()), []);
  assert.equal(h.requests.length, 3);
  session.destroy();
});

for (const attrs of [{}, { authenticationContext: { action: "AUTHENTICATE", endpoint: "ZW5kcG9pbnQ", authenticationRequest: "cGF5bG9hZA" } }, { authenticationContext: { action: "REGISTER" } },
  { authenticationContext: { action: "OTHER", endpoint: "e", payload: "p", identifier: "i" } }]) {
  test(`missing or unknown context does not imply preparation is ready: ${JSON.stringify(attrs)}`, async () => {
    const h = harness(attrs);
    const session = await h.create().startSession();
    assert.equal(session.preparationState, "unsupported_context");
    await assert.rejects(session.authenticate(), { code: "preparation_continuation_unavailable" });
    assert.equal(h.commands.length, 1);
    session.destroy();
  });
}

for (const dropType of ["AUTH_READY", "AUTH_SESSION_CREATED"]) {
  test(`timeout during ${dropType} cleans up without an attestation request`, async () => {
    const h = harness({}, { dropType });
    await assert.rejects(h.create({ timeout: 5 }).startSession(), /Timeout/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.frames[0].removed, true);
    assert.equal(h.listeners.size, 0);
  });
}

const registerContext = { action: "REGISTER", endpoint: "opaque-register", payload: "opaque-challenge", identifier: "registration" };
const paymentContext = { action: "AUTHENTICATE", endpoint: "opaque-payment", payload: "opaque-challenge", identifier: "id" };

test("registration-only setup ends after Visa completion without requesting PAYMENT options", async () => {
  const h = harness({}, { responses: [{ authenticationContext: registerContext }] });
  const session = await h.create({ ...h.continuation, registrationOnly: true }).startSession();
  assert.deepEqual(copy(await session.authenticate()), { status: "registration_complete" });
  assert.equal(session.preparationState, "registration_complete");
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.commands.map((command) => command.type), ["CREATE_AUTH_SESSION", "AUTHENTICATE", "CLOSE_AUTH_SESSION"]);
  await assert.rejects(session.authenticate());
  assert.equal(h.requests.length, 1);
  session.destroy();
});

test("3DS followed by registration-only setup never makes a payment continuation request", async () => {
  const h = harness({}, { responses: [
    { status: "CHALLENGE", stepUpRequest: [web] }, { authenticationContext: registerContext },
  ] });
  const session = await h.create({ ...h.continuation, registrationOnly: true }).startSession();
  const pending = session.authenticate();
  h.callback();
  assert.deepEqual(copy(await pending), { status: "registration_ready" });
  assert.deepEqual(copy(await session.authenticate()), { status: "registration_complete" });
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests.map((request) => request.body.data.attributes.continuation), [undefined, "web_challenge"]);
  session.destroy();
});

test("registration-only option cannot change the legacy flow", () => {
  for (const options of [{ registrationOnly: "true" }, { registrationOnly: true, preparationMode: undefined }]) {
    assert.throws(() => harness({}).create(options), /Registration-only/);
  }
});

for (const returnedIdentifier of [undefined, "returned-payment-id"]) {
  test(`PAYMENT retains its identifier when the optional response field is ${returnedIdentifier}`, async () => {
    const h = harness({ authenticationContext: { ...paymentContext, identifier: "context-payment-id" } }, {
      paymentAssurance: { fidoBlob: "synthetic-payment", ...(returnedIdentifier ? { identifier: returnedIdentifier } : {}) },
    });
    const session = await h.create(h.continuation).startSession();
    try {
      const evidence = await session.authenticate();
      assert.equal(evidence[0].methodResults.identifier, returnedIdentifier ?? "context-payment-id");
      assert.equal(evidence[0].methodResults.fidoAssertionData.code, "synthetic-payment");
      assert.equal(evidence[0].verificationEntity, "10");
      assert.equal(session.preparationState, "complete");
    } finally { session.destroy(); }
  });
}

test("PAYMENT context identifier cannot replace missing FIDO evidence", async () => {
  const h = harness({ authenticationContext: paymentContext }, { paymentAssurance: {} });
  const session = await h.create(h.continuation).startSession();
  try {
    await assert.rejects(session.authenticate(), { code: "payment_evidence_unavailable" });
    assert.equal(session.preparationState, "failed");
  } finally { session.destroy(); }
});

test("WEB callback completion then REGISTER then PAYMENT require separate continuation and never reuse registration evidence", async () => {
  const h = harness({}, { responses: [
    { status: "CHALLENGE", stepUpRequest: [web] },
    { authenticationContext: registerContext }, { authenticationContext: paymentContext },
  ] });
  const sdk = h.create(h.continuation);
  const session = await sdk.startSession();
  const challenge = session.authenticate();
  assert.equal(h.popups.length, 1);
  const launch = new URL(h.popups[0].location.href);
  assert.equal(launch.searchParams.get("existing"), "1");
  const returned = new URL(launch.searchParams.get("wpcallback"));
  assert.equal(returned.searchParams.get("frontend_origin"), "https://localhost:4200");
  assert.equal(returned.searchParams.has("secureToken"), false);
  h.callback();
  assert.deepEqual(copy(await challenge), { status: "registration_ready" });
  assert.equal(h.requests[1].body.data.attributes.issuer_auth_code, "synthetic-code");
  assert.equal(h.requests[1].body.data.attributes.continuation, "web_challenge");
  h.callback();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(copy(await session.authenticate()), { status: "awaiting_payment" });
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].body.data.attributes.continuation, "registration_complete");
  assert.equal(h.requests[2].body.data.attributes.authentication_amount, undefined);
  assert.equal(h.commands.filter((c) => c.type === "AUTHENTICATE").length, 1);
  assert.equal(h.popups.length, 1);
  const evidence = await session.authenticate();
  assert.equal(h.popups.length, 2);
  assert.equal(h.commands.filter((c) => c.type === "CREATE_AUTH_SESSION").length, 1);
  assert.equal(evidence[0].methodResults.fidoAssertionData.code, "synthetic-payment");
  assert.equal(evidence[0].verificationEntity, "10");
  assert.equal(h.commands.filter((c) => c.popup && c.type === "AUTHENTICATE")[0].authenticationContext.action, "AUTHENTICATE");
  await assert.rejects(session.authenticate(), /Cannot call/);
  session.destroy();
});

for (const [result, code] of [["declined", "verification_declined"], ["failure", "verification_failed"], ["unexpected", "invalid_callback"]]) {
  test(`issuer ${result} never fetches registration or payment context`, async () => {
    const h = harness({ status: "CHALLENGE", stepUpRequest: [web] });
    const session = await h.create(h.continuation).startSession();
    const pending = session.authenticate();
    h.callback({ stepupresponse: result });
    await assert.rejects(pending, { code });
    assert.equal(h.requests.length, 1);
    assert.equal(h.popups[0].closed, true);
    session.destroy();
  });
}

test("approval without authentication code requests registration options", async () => {
  const h = harness({}, { responses: [
    { status: "CHALLENGE", stepUpRequest: [web] },
    { authenticationContext: registerContext },
  ] });
  const session = await h.create(h.continuation).startSession();
  const pending = session.authenticate();
  h.callback({ stepupauthcode: undefined });
  assert.deepEqual(copy(await pending), { status: "registration_ready" });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.data.attributes.continuation, "web_challenge");
  assert.equal(h.requests[1].body.data.attributes.issuer_auth_code, undefined);
  session.destroy();
});

test("local sandbox can resume from the matching approved callback URL when the hosted page fails", async () => {
  const h = harness({}, { responses: [
    { status: "CHALLENGE", stepUpRequest: [web] },
    { authenticationContext: registerContext },
  ] });
  const session = await h.create(h.continuation).startSession();
  const pending = session.authenticate();
  const launch = new URL(h.popups[0].location.href);
  const returned = new URL(launch.searchParams.get("wpcallback"));
  returned.searchParams.set("stepupresponse", "approved");
  const wrongAttempt = new URL(returned.href);
  wrongAttempt.searchParams.set("attempt_id", "another-attempt");
  assert.throws(() => session.submitSandboxCallbackUrl(wrongAttempt.href), { code: "invalid_callback" });
  assert.equal(h.requests.length, 1);
  session.submitSandboxCallbackUrl(returned.href);
  assert.deepEqual(copy(await pending), { status: "registration_ready" });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.data.attributes.issuer_auth_code, undefined);
  session.destroy();
});

for (const override of [{ origin: "https://evil.example" }, { source: {} }]) {
  test(`callback rejects mismatched origin or window: ${JSON.stringify(override)}`, async () => {
    const h = harness({}, { responses: [{ status: "CHALLENGE", stepUpRequest: [web] }, { authenticationContext: registerContext }] });
    const session = await h.create(h.continuation).startSession();
    const pending = session.authenticate();
    h.callback({}, override);
    assert.equal(h.requests.length, 1);
    h.callback();
    await pending;
    assert.equal(h.requests.length, 2);
    session.destroy();
  });
}

test("a stale callback attempt fails without backend completion", async () => {
  const h = harness({ status: "CHALLENGE", stepUpRequest: [web] });
  const session = await h.create(h.continuation).startSession();
  const pending = session.authenticate();
  h.callback({ attempt_id: "stale-attempt" });
  await assert.rejects(pending, { code: "callback_attempt_mismatch" });
  assert.equal(h.requests.length, 1);
  session.destroy();
});

test("checkout changes during callback prevent continuation", async () => {
  const h = harness({ status: "CHALLENGE", stepUpRequest: [web] });
  const session = await h.create(h.continuation).startSession();
  const pending = session.authenticate();
  h.changeCheckout("different-buyer-card-cart");
  h.callback();
  await assert.rejects(pending, { code: "checkout_context_changed" });
  assert.equal(h.requests.length, 1);
  session.destroy();
});

for (const change of ["tokenId", "authenticationAmount", "clientRefId"]) {
  test(`changed ${change} prevents continuation`, async () => {
    const h = harness({ authenticationContext: paymentContext });
    const sdk = h.create(h.continuation);
    const session = await sdk.startSession();
    sdk[change] = "changed";
    await assert.rejects(session.authenticate(), { code: "checkout_context_changed" });
    assert.equal(h.popups.length, 0);
    session.destroy();
  });
}

test("elapsed time alone does not reject a browser session", async () => {
  const h = harness({ authenticationContext: paymentContext });
  const session = await h.create(h.continuation).startSession();
  h.advanceTime(900_000);
  assert.equal((await session.authenticate())[0].verificationEntity, "10");
  assert.equal(h.requests.length, 1);
  session.destroy();
});

test("blocked popup stops without backend continuation", async () => {
  const h = harness({ authenticationContext: paymentContext }, { popupBlocked: true });
  const session = await h.create(h.continuation).startSession();
  await assert.rejects(session.authenticate(), { code: "popup_blocked" });
  assert.equal(h.requests.length, 1);
  session.destroy();
});

for (const failure of ["AUTH_FAILED", "AUTH_CANCELLED", "AUTH_NOT_SUPPORTED", "AUTH_NOT_PERFORMED"]) {
  test(`PAYMENT ${failure} never returns evidence`, async () => {
    const h = harness({ authenticationContext: paymentContext }, { popupFailure: failure });
    const session = await h.create(h.continuation).startSession();
    await assert.rejects(session.authenticate(), { code: failure.toLowerCase() });
    session.destroy();
  });
}

test("destroy cancels a pending callback and removes its listeners", async () => {
  const h = harness({ status: "CHALLENGE", stepUpRequest: [web] });
  const session = await h.create(h.continuation).startSession();
  const pending = session.authenticate();
  session.destroy();
  await assert.rejects(pending, { code: "verification_cancelled" });
  assert.equal(h.listeners.size, 0);
  assert.equal(h.popups[0].closed, true);
});

test("callback timeout stops without provider completion", async () => {
  const h = harness({ status: "CHALLENGE", stepUpRequest: [web] });
  const session = await h.create(h.continuation).startSession();
  await assert.rejects(session.authenticate(), { code: "verification_timeout" });
  assert.equal(h.listeners.size, 0);
  assert.equal(h.requests.length, 1);
  session.destroy();
});

test("issuer wait has no default time limit", async () => {
  const h = harness({}, { responses: [
    { status: "CHALLENGE", stepUpRequest: [web] }, { authenticationContext: registerContext },
  ] });
  const session = await h.create({ ...h.continuation, timeout: undefined }).startSession();
  const settled = session.authenticate().then((value) => ({ value }), (error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.callback();
  assert.deepEqual(copy((await settled).value), { status: "registration_ready" });
  session.destroy();
});


test("closing the issuer window is cancellation rather than timeout", async () => {
  const h = harness({ status: "CHALLENGE", stepUpRequest: [web] });
  const session = await h.create({ ...h.continuation, timeout: 500 }).startSession();
  const pending = session.authenticate();
  h.popups[0].close();
  await assert.rejects(pending, { code: "verification_cancelled" });
  assert.equal(h.requests.length, 1);
  assert.equal(h.listeners.size, 0);
  session.destroy();
});

test("session context changed during WEB callback stops without completion", async () => {
  const h = harness({ status: "CHALLENGE", stepUpRequest: [web] });
  const session = await h.create(h.continuation).startSession();
  const pending = session.authenticate();
  session._sessionContext.secureToken = "different-session";
  h.callback();
  await assert.rejects(pending, { code: "checkout_context_changed" });
  assert.equal(h.requests.length, 1);
  session.destroy();
});

test("issuer callback can continue after elapsed time", async () => {
  const h = harness({}, { responses: [
    { status: "CHALLENGE", stepUpRequest: [web] }, { authenticationContext: registerContext },
  ] });
  const session = await h.create(h.continuation).startSession();
  const pending = session.authenticate();
  h.advanceTime(900_000);
  h.callback();
  assert.deepEqual(copy(await pending), { status: "registration_ready" });
  assert.equal(h.requests.length, 2);
  session.destroy();
});


test("EU verification retains merchant URL and locale through registration continuation", async () => {
  const h = harness({}, { responses: [{ status: "CHALLENGE", stepUpRequest: [web] }, { authenticationContext: registerContext }] });
  const values = { merchantUrl: "https://shop.example", merchantName: "Shop", consumerLocale: "en_GB", authenticationAmount: "456.37", currencyCode: "978" };
  const session = await h.create({ ...h.continuation, ...values }).startSession();
  const continuation = session.authenticate();
  h.callback();
  await continuation;
  for (const request of h.requests) {
    const attrs = request.body.data.attributes;
    assert.equal(attrs.merchant_url, values.merchantUrl);
    assert.equal(attrs.consumer_locale, values.consumerLocale);
    assert.equal(attrs.authentication_amount, values.authenticationAmount);
  }
  session.destroy();
});

test("new binding is explicit and requires Europe preparation", async () => {
  const h = harness({ result: "CHALLENGE", stepUpRequest: [web] });
  const session = await h.create({ ...h.continuation, startDeviceBinding: true }).startSession();
  assert.equal(h.requests[0].body.data.attributes.start_device_binding, true);
  assert.equal(session.preparationState, "web_challenge_pending");
  assert.throws(() => h.create({ preparationMode: undefined, startDeviceBinding: true }), /Europe preparation/);
  session.destroy();
});
