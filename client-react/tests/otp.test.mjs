import assert from "node:assert/strict";
import { test } from "node:test";
import { flowFromEnrollResponse, stepsFor } from "../src/flow.ts";
import { getStepUpOptions, requestOtp, submitOtp, completeEnrollment, IdvError, idvErrorInfo, idvErrorPayload, newClientRefId, readOtpDelivery, readOtpVerification } from "../src/idv.ts";

for (const verification of [null, "passkey", "otp", "none"]) {
  for (const enrollmentRequired of [false, true]) {
    test(`Visa preserves ${verification ?? "legacy"} flow, enrollment=${enrollmentRequired}`, () => {
      const verificationSteps = verification === "none" ? []
        : [verification === "otp" ? "idv" : "deviceBinding"];
      assert.deepEqual(stepsFor("visa", verification, enrollmentRequired), [
        "card", "enroll", ...verificationSteps,
        ...(enrollmentRequired ? ["agenticEnroll"] : []), "intent", "cryptogram", "confirm",
      ]);
    });

    test(`Mastercard preserves ${verification ?? "legacy"} flow, enrollment=${enrollmentRequired}`, () => {
      assert.deepEqual(stepsFor("mastercard", verification, enrollmentRequired), ["card", "enroll", "otpOptions", "idv", "cryptogram"]);
    });

    test(`Amex ${verification ?? "legacy"} flow, enrollment=${enrollmentRequired}`, () => {
      assert.deepEqual(stepsFor("amex", verification, enrollmentRequired), [
        "card", "enroll", ...(verification === "otp" ? ["idv"] : []), "cryptogram", "deleteEnrollment",
      ]);
    });
  }
}

test("missing and unknown verification fields keep legacy defaults", () => {
  for (const response of [undefined, {}, { data: {} }, { data: { attributes: {} } },
    { data: { attributes: { cardholder_verification: "unexpected", agentic_enrollment_required: "true" } } }]) {
    assert.deepEqual(flowFromEnrollResponse(response), {
      verification: "passkey", agenticEnrollmentRequired: false,
    });
  }
});

test("Amex enrollment selects OTP only when the API explicitly requests it", () => {
  const { verification, agenticEnrollmentRequired } = flowFromEnrollResponse({
    data: { attributes: {
      cardholder_verification: "otp", agentic_enrollment_required: false,
      client_ref_id: "opaque-reference", stepUpRequest: [{ method: "OTPEMAIL", identifier: "channel" }],
    } },
  });
  assert.deepEqual(stepsFor("amex", verification, agenticEnrollmentRequired), ["card", "enroll", "idv", "cryptogram", "deleteEnrollment"]);
});

test("Visa can still fetch OTP methods and complete enrollment with the existing contract", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ data: { attributes: {
      status: "CHALLENGE", passkey_required: false,
      stepUpRequest: [{ method: "OTPSMS", identifier: "sms" }, { method: "FIDO", identifier: "passkey" }],
    } } });
  });
  const options = await getStepUpOptions("token", "reference");
  assert.equal(options.passkeyRequired, false);
  assert.deepEqual(options.methods, [{ method: "OTPSMS", identifier: "sms" }]);
  assert.equal(calls[0].url, "/api/step-up-options?tokenId=token&clientRefId=reference");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
  await completeEnrollment("token", "cardholder@example.com");
  assert.equal(calls[1].url, "/api/agentic-enrollments?tokenId=token");
  assert.deepEqual(JSON.parse(calls[1].body), {
    data: { type: "agentic_enrollments", attributes: { consumer_email: "cardholder@example.com" } },
  });
});

test("OTP delivery, resend and verification preserve opaque references and the existing request fields", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options });
    return new Response(null, { status: 204 });
  });
  const reference = "opaque/provider+reference=";
  await requestOtp("token/id", reference, "channel/id");
  await requestOtp("token/id", reference, "channel/id");
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[0].url, "/api/otp/channel%2Fid?tokenId=token%2Fid");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), {
    data: { type: "otp_methods", attributes: { client_ref_id: reference } },
  });
  await submitOtp("token/id", reference, "cardholder@example.com", "123456");
  assert.equal(calls[2].url, "/api/otp?tokenId=token%2Fid");
  assert.deepEqual(JSON.parse(calls[2].body), {
    data: { type: "otp_submissions", attributes: {
      otp: "123456", client_ref_id: reference, consumer_email: "cardholder@example.com",
      session_context: {}, browser_data: {},
    } },
  });
});

test("a rejected OTP remains an error and cannot complete verification", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    error: "invalid_otp", detail: "Incorrect code",
  }, { status: 400 }));
  await assert.rejects(submitOtp("token", "reference", "cardholder@example.com", "000000"), (error) => {
    assert.ok(error instanceof IdvError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_otp");
    return true;
  });
});

const response = (type, id, attributes) => ({ data: { type, id, attributes } });
test("Mastercard creates a short lookup marker and uses a new session reference only for verification", () => {
  const original = newClientRefId("mastercard");
  assert.match(original, /^vgs:ms:v1:[\w-]+$/);
  assert.ok(original.length <= 64);
  const reference = readOtpDelivery(response("otp_methods", "selected", { method: "SMS", client_ref_id: "vgs:ms:v1:session-1" }), "selected", original);
  assert.equal(reference, "vgs:ms:v1:session-1");
  const pending = readOtpVerification(response("otp_submissions", "token", { status: "PENDING", client_ref_id: "vgs:ms:v1:session-2" }), "token", reference);
  assert.deepEqual(pending, { status: "pending", clientRefId: "vgs:ms:v1:session-2" });
  assert.equal(readOtpVerification(response("otp_submissions", "token", { status: "VALIDATED" }), "token", pending.clientRefId).status, "verified");
  assert.equal(readOtpVerification(response("otp_submissions", "token", { status: "REJECTED" }), "token", pending.clientRefId).status, "rejected");
});

test("Mastercard cannot use missing, stale, mismatched or malformed verification responses", () => {
  const ref = "vgs:ms:v1:attempt";
  for (const body of [null, {}, response("otp_methods", "other", {}), response("otp_methods", "method", {}),
    response("otp_methods", "method", { client_ref_id: ref })]) {
    assert.throws(() => readOtpDelivery(body, "method", ref), IdvError);
  }
  for (const body of [response("otp_submissions", "other-token", { status: "VALIDATED" }),
    response("otp_submissions", "token", { status: "PENDING" }), response("otp_submissions", "token", {}),
    response("otp_submissions", "token", { status: "ACTIVE" })]) {
    assert.throws(() => readOtpVerification(body, "token", ref), IdvError);
  }
});

test("Visa and Amex retain references and use provider verification status", () => {
  for (const ref of ["visa-attempt", "vgs:amex:v1:session"]) {
    assert.equal(readOtpDelivery(response("otp_methods", "method", { method: null }), "method", ref), ref);
    for (const status of ["ACTIVE", "VALIDATED", "APPROVED", "AUTHENTICATED"]) {
      assert.equal(readOtpVerification(response("otp_submissions", "token", { status }), "token", ref).status, "verified");
    }
    assert.equal(readOtpVerification(response("otp_submissions", "token", { status: "PENDING" }), "token", ref).status, "pending");
  }
});

const fullErrorBody = {
  error: "mastercard_upstream_error",
  detail: "Mastercard identity verification request failed.",
  mastercard_response: {
    status: 400,
    body: { reason: "INVALID_STATE", errordetail: [{
      reason: "INVALID_VALUE", source: "authenticationMethod.methodAttributes.otpValue",
      message: "Incorrect OTP value provided. OTP attempt 1 of 3.",
    }] },
  },
  meta: { observability: { trace_id: "test-trace", vault_id: "test-vault", network_correlation_id: "correlation" } },
  additional_diagnostics: { entries: ["extra field", { reference: `vgs:ms:v1:${"encoded".repeat(20)}` }] },
};

for (const [step, invoke] of [
  ["lookup", () => getStepUpOptions("token", "reference")],
  ["delivery", () => requestOtp("token", "reference", "method")],
  ["verification", () => submitOtp("token", "reference", "cardholder@example.com", "654321")],
  ["enrollment", () => completeEnrollment("token", "cardholder@example.com")],
]) {
  test(`${step} preserves the complete API error body for display`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(fullErrorBody, { status: 409 }));
    await assert.rejects(invoke(), (error) => {
      assert.equal(idvErrorInfo(error).status, 409);
      assert.equal(idvErrorInfo(error).code, "mastercard_upstream_error");
      assert.deepEqual(idvErrorPayload(error), fullErrorBody);
      return true;
    });
  });
}

test("successful lookup and OTP responses preserve all API fields without masking", async (t) => {
  const body = { data: { attributes: {
    passkey_required: false, stepUpRequest: [{ method: "OTPSMS", identifier: "method" }],
    client_ref_id: `vgs:ms:v1:${"encoded".repeat(20)}`,
    assurance_data: ["synthetic-proof"], additionalData: "synthetic-data", otp: "654321",
  } }, meta: fullErrorBody.meta };
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  assert.deepEqual((await getStepUpOptions("token", "reference")).raw, body);
  assert.deepEqual(await requestOtp("token", "reference", "method"), body);
  assert.deepEqual(await submitOtp("token", "reference", "cardholder@example.com", "654321"), body);
});

test("non-JSON API errors preserve the returned text", async (t) => {
  const body = "Upstream unavailable: example diagnostic";
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 502 }));
  await assert.rejects(requestOtp("token", "reference", "method"), (error) => {
    assert.equal(idvErrorPayload(error), body);
    return true;
  });
  assert.deepEqual(idvErrorPayload(new Error("Local failure")), { error: "Local failure" });
});
