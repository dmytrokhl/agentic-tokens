import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { v2Path, installV2Routes } from "../v2-adapter.js";
import { europeBrowserConfig } from "../europe-config.js";
import { installMockMerchantRoutes } from "../mock-merchant.js";

const query = (extra = {}) => new URLSearchParams({ visaFlow: "v2", cardId: "card/id", tokenId: "token/id", ...extra });
test("v2 maps first and later credentials, confirmation and body-bearing cancellation without changing defaults", () => {
  assert.equal(v2Path("cryptograms", "POST", new URLSearchParams()), null);
  const base = "/agentic-tokens/v2/cards/card%2Fid/token%2Fid";
  assert.equal(v2Path("cryptograms", "POST", query()), `${base}/cryptograms`);
  assert.equal(v2Path("cryptograms", "POST", query({ intentId: "intent/id" })), `${base}/intents/intent%2Fid/cryptograms`);
  assert.equal(v2Path("confirmations", "POST", query({ intentId: "instruction" })), `${base}/intents/instruction/confirmations`);
  assert.equal(v2Path("intents", "DELETE", query({ intentId: "instruction" })), `${base}/intents/instruction`);
  assert.throws(() => v2Path("intents", "POST", query()), { status: 405 });
  assert.throws(() => v2Path("confirmations", "POST", query()), { status: 400 });
});

test("callback config is opt-in HTTPS and rejects query parameters or credentials", () => {
  assert.deepEqual(europeBrowserConfig({}), { visaEuCallbackUrl: null, visaEnvironment: "sandbox" });
  assert.equal(europeBrowserConfig({ AGENTIC_VISA_EU_CALLBACK_URL: "https://callback.example/return" }).visaEuCallbackUrl,
    "https://callback.example/return");
  for (const value of ["http://callback.example", "https://user:password@callback.example", "https://callback.example/?attempt=x", "https://callback.example/#x"]) {
    assert.throws(() => europeBrowserConfig({ AGENTIC_VISA_EU_CALLBACK_URL: value }));
  }
});

async function listening(t, setup) {
  const app = express(); app.use(express.json()); setup(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("Express and hosted adapter use the same v2 path and preserve the DELETE body", async (t) => {
  const calls = [];
  const base = await listening(t, (app) => installV2Routes(app, { apiUrl: "https://api.invalid", callVgs: async (...args) => {
    calls.push(args); return { status: 200, data: { data: { id: "instruction" } } };
  } }));
  const body = { data: { type: "intents", attributes: { agent: "configured-agent", assurance_data: [{ opaque: "evidence" }] } } };
  const response = await fetch(`${base}/api/intents?${query({ intentId: "instruction" })}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], ["https://api.invalid", "DELETE", v2Path("intents", "DELETE", query({ intentId: "instruction" })), body]);
});

test("local mock merchant records match request, wallet, and session bridge contracts", async (t) => {
  const base = await listening(t, installMockMerchantRoutes);
  const send = async (path, method, body) => fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const request = await (await send("/api/payment-requests", "POST", { id: "fixture", buyerId: "buyer", amount: 5, currency: "EUR" })).json();
  assert.equal(request.simulated, true);
  assert.equal(request.status, "pending");
  assert.equal((await fetch(`${base}/api/payment-requests/fixture`)).status, 200);
  await send("/api/subscriptions/buyer", "POST", { cardId: "card", tokenId: "token", status: "enrolled" });
  await send("/api/subscriptions/buyer", "POST", { intentId: "instruction", status: "active" });
  const wallet = await (await fetch(`${base}/api/subscriptions/buyer`)).json();
  assert.equal(wallet.subscription.tokenId, "token");
  assert.equal(wallet.subscription.active, true);
  assert.equal((await send("/api/sessions/binding-fixture", "POST", { phase: "REGISTER", assuranceData: [{}] })).status, 400);
  const result = { phase: "PAYMENT", cardId: "card", tokenId: "token", assuranceData: [{ opaque: "evidence" }] };
  assert.equal((await send("/api/sessions/binding-fixture", "POST", result)).status, 200);
  assert.equal((await send("/api/sessions/binding-fixture", "POST", result)).status, 409);
  assert.equal((await (await fetch(`${base}/api/sessions/binding-fixture`)).json()).phase, "PAYMENT");
});

test("Netlify functions preserve all selected v2 paths and cancellation bodies", async () => {
  const { spawnSync } = await import("node:child_process");
  const entries = Object.fromEntries(["cryptograms", "confirmations", "intents"].map((name) => [name,
    new URL(`../../netlify/functions/${name}.js`, import.meta.url).href]));
  const script = `
    import assert from 'node:assert/strict';
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({url, options});
      return Response.json(url.includes('/token') ? {access_token:'synthetic-access',expires_in:3600} : {data:{id:'instruction'}});
    };
    const paths = ${JSON.stringify(entries)};
    for (const [name, method, suffix] of [['cryptograms','POST','/cryptograms'],['cryptograms','POST','/intents/i/cryptograms'],
      ['confirmations','POST','/intents/i/confirmations'],['intents','DELETE','/intents/i']]) {
      const handler = (await import(paths[name])).default;
      const withIntent = suffix.includes('/intents/');
      const url = 'https://merchant.invalid/api/'+name+'?visaFlow=v2&cardId=c&tokenId=t'+(withIntent?'&intentId=i':'');
      const body = {data:{type:name,attributes:{agent:'synthetic-agent',opaque:'do-not-log-body'}}};
      const result = await handler(new Request(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
      assert.equal(result.status,200);
      const request = calls.at(-1);
      assert.equal(request.url,'https://api.invalid/agentic-tokens/v2/cards/c/t'+suffix);
      assert.equal(request.options.method,method);
      assert.deepEqual(JSON.parse(request.options.body),body);
    }
    console.log('VERIFIED_V2_HOSTED');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, VGS_API_URL: "https://api.invalid", VGS_AUTH_URL: "https://auth.invalid/token", VGS_CLIENT_ID: "synthetic-client", VGS_CLIENT_SECRET: "synthetic-secret" },
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /VERIFIED_V2_HOSTED/);
  assert.equal(child.stdout.includes("do-not-log-body"), false);
});
