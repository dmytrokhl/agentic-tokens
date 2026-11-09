import assert from "node:assert/strict";
import { test } from "node:test";
import { installDeviceBindingRoutes, removeDeviceBinding } from "../device-bindings.js";

test("removal proxies the canonical path without a request body", async () => {
  const calls = [];
  const upstream = { status: 200, data: { data: { attributes: { result: "CHALLENGE" } } } };
  const result = await removeDeviceBinding(" token/one ", " device-123 ", (...args) => { calls.push(args); return upstream; }, "https://api.invalid");
  assert.equal(result, upstream);
  assert.deepEqual(calls, [["https://api.invalid", "DELETE", "/agentic-tokens/token%2Fone/device-bindings/device-123"]]);
});

test("invalid or repeated query parameters cannot reach VGS", async () => {
  for (const [token, device] of [[null, "device"], ["", "device"], [["token"], "device"], ["token", ["device"]],
    ["token", ""], ["token", "../device"], ["token", "x".repeat(25)]]) {
    const result = await removeDeviceBinding(token, device, () => assert.fail("Unexpected VGS request"), "https://api.invalid");
    assert.equal(result.status, 400);
  }
});

test("Express exposes the deletion endpoint and preserves status and result", async () => {
  let handler;
  installDeviceBindingRoutes({ delete(path, fn) { assert.equal(path, "/api/device-bindings"); handler = fn; } }, {
    apiUrl: "https://api.invalid", callVgs: async () => ({ status: 409, data: { error: "provider-result" } }),
  });
  const output = {};
  const res = { status(value) { output.status = value; return this; }, json(value) { output.data = value; } };
  await handler({ query: { tokenId: "token", deviceId: "device" } }, res);
  assert.deepEqual(output, { status: 409, data: { error: "provider-result" } });
});

test("transport errors expose a fixed message without private details", async () => {
  let handler;
  installDeviceBindingRoutes({ delete(_path, fn) { handler = fn; } }, {
    apiUrl: "https://api.invalid", callVgs: async () => { throw new Error("private-provider-detail"); },
  });
  const output = {};
  await handler({ query: { tokenId: "token", deviceId: "device" } }, {
    status(value) { output.status = value; return this; }, json(value) { output.data = value; },
  });
  assert.equal(output.status, 502);
  assert.equal(JSON.stringify(output).includes("private-provider-detail"), false);
});

test("hosted handler validates methods and proxies the same bodyless deletion", async (t) => {
  const env = { VGS_API_URL: "https://api.invalid", VGS_AUTH_URL: "https://auth.invalid/token",
    VGS_CLIENT_ID: "fixture-client", VGS_CLIENT_SECRET: "fixture-secret" };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const { default: hosted } = await import("../../netlify/functions/device-bindings.js");
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return url === env.VGS_AUTH_URL ? Response.json({ access_token: "fixture-token", expires_in: 3600 })
      : Response.json({ data: { attributes: { result: "APPROVED" } } });
  });
  assert.equal((await hosted(new Request("https://demo.invalid/api/device-bindings"))).status, 405);
  assert.equal((await hosted(new Request("https://demo.invalid/api/device-bindings", { method: "DELETE" }))).status, 400);
  assert.equal(calls.length, 0);
  const result = await hosted(new Request("https://demo.invalid/api/device-bindings?tokenId=token%2Fone&deviceId=device", { method: "DELETE" }));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).data.attributes.result, "APPROVED");
  assert.equal(calls[1].url, "https://api.invalid/agentic-tokens/token%2Fone/device-bindings/device");
  assert.equal(calls[1].options.method, "DELETE");
  assert.equal(Object.hasOwn(calls[1].options, "body"), false);
});
