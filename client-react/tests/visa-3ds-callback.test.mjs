import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/callback/callback.js", import.meta.url), "utf8");
const { deliverCallback } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const merchant = "https://localhost:4200";
function fixture(extra = {}, { opener = true, duplicate } = {}) {
  const calls = [];
  const url = new URL("https://localhost:9445/visa-3ds-callback/");
  for (const [key, value] of Object.entries({ attempt_id: "synthetic-attempt-123", frontend_origin: merchant,
    stepupresponse: "Approved", stepupauthcode: "synthetic-code", ...extra })) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  if (duplicate) url.searchParams.append(duplicate, "second-value");
  return { calls, browser: {
    location: { href: url.href },
    history: { replaceState: (...args) => calls.push({ scrub: args }) },
    opener: opener ? { closed: false, postMessage: (payload, target) => calls.push({ payload, target }) } : null,
  } };
}

test("callback forwards only documented fields to the exact configured opener origin and removes query data", () => {
  const { browser, calls } = fixture();
  deliverCallback(browser, [merchant]);
  assert.deepEqual(calls, [
    { scrub: [null, "", "/visa-3ds-callback/"] },
    { payload: { type: "vgs:3ds-result", attempt_id: "synthetic-attempt-123", stepupresponse: "approved", stepupauthcode: "synthetic-code" }, target: merchant },
  ]);
});
for (const result of ["Approved", "Declined", "Failure"]) {
  test(`callback preserves ${result} without implying payment evidence`, () => {
    const { browser, calls } = fixture({ stepupresponse: result, stepupauthcode: undefined });
    deliverCallback(browser, [merchant]);
    assert.equal(calls[1].payload.stepupresponse, result.toLowerCase());
    assert.equal(calls[1].payload.stepupauthcode, undefined);
    assert.equal(calls[1].payload.assuranceData, undefined);
  });
}
for (const origins of [[], ["*"], ["https://localhost:4200/"], ["https://evil.example"]]) {
  test(`callback rejects an unconfigured or inexact frontend allowlist: ${JSON.stringify(origins)}`, () => {
    const { browser, calls } = fixture();
    assert.throws(() => deliverCallback(browser, origins));
    assert.equal(calls.length, 0);
  });
}
for (const parameter of ["attempt_id", "frontend_origin", "stepupresponse", "stepupauthcode"]) {
  test(`callback rejects duplicate ${parameter}`, () => {
    const { browser, calls } = fixture({}, { duplicate: parameter });
    assert.throws(() => deliverCallback(browser, [merchant]), /Duplicate/);
    assert.equal(calls.length, 0);
  });
}
for (const data of [{ attempt_id: "short" }, { attempt_id: undefined }, { frontend_origin: "null" },
  { frontend_origin: "https://localhost:4200@evil.example" }, { stepupresponse: "unknown" },
  { stepupresponse: "Declined" }, { stepupresponse: "Failure" }, { stepupauthcode: "" }]) {
  test(`callback rejects malformed or inconsistent fields: ${JSON.stringify(data)}`, () => {
    const { browser, calls } = fixture(data);
    assert.throws(() => deliverCallback(browser, [merchant]));
    assert.equal(calls.length, 0);
  });
}

test("callback cannot resume when the original opener is unavailable", () => {
  const { browser } = fixture({}, { opener: false });
  assert.throws(() => deliverCallback(browser, [merchant]), /original window/);
});

test("callback does not read WEBAUTH_STATUS as an alternative return contract", () => {
  const { browser } = fixture({ stepupresponse: undefined, stepupauthcode: undefined });
  browser.WEBAUTH_STATUS = "approved";
  assert.throws(() => deliverCallback(browser, [merchant]), /Invalid verification result/);
});
