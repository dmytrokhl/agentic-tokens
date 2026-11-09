import assert from "node:assert/strict";
import { test } from "node:test";
import { activateMockScenario, fixtureScenarios, isEuropeSample } from "../src/sample-journeys.ts";
import { loadCollectJs } from "../src/api.ts";

const config = { mockMode: "vic-v2-europe", mockScenarios: [
  { scenario: "visa-otp", network: "visa" }, { scenario: "eu-web", network: "visa" },
  { scenario: "mastercard", network: "mastercard" },
] };

test("Europe sample requires its explicit entry parameter; normal landing stays original", () => {
  assert.equal(isEuropeSample(""), false);
  assert.equal(isEuropeSample("?flow=otp"), false);
  assert.equal(isEuropeSample("?flow=visa-v2-europe"), true);
  assert.deepEqual(fixtureScenarios(config, "visa", true).map((item) => item.scenario), ["eu-web"]);
});

test("Europe fixture activation uses only server-returned local profiles", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) }); return { ok: true };
  });
  await activateMockScenario(config, "eu-web");
  assert.deepEqual(calls, [{ url: "/api/mock/scenario", body: { scenario: "eu-web" } }]);
  await assert.rejects(activateMockScenario({}, "eu-web"));
  await assert.rejects(activateMockScenario(config, "unlisted"));
  assert.equal(calls.length, 1);
});

test("empty Collect configuration fails visibly before creating a script or network request", async () => {
  await assert.rejects(loadCollectJs(""), /Collect is unavailable in the EU local simulator/);
  await assert.rejects(loadCollectJs("  "), /configured provider runtime/);
});
