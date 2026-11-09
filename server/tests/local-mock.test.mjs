import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { readMockConfig } from "../mock-config.js";
import { installMockRoutes, mockBrowserConfig, MOCK_SCENARIOS } from "../local-mock.js";

const mockEnv = { AGENTIC_MOCK_MODE: "vic-v2-europe" };

test("mock mode accepts only explicit local configuration", () => {
  assert.equal(readMockConfig({}), null);
  const config = readMockConfig(mockEnv);
  assert.equal(config.authUrl, "http://localhost:9999/mock/oauth/token");
  assert.deepEqual(mockBrowserConfig(config), {
    mockMode: "vic-v2-europe", mockScenarios: MOCK_SCENARIOS, mockScenario: MOCK_SCENARIOS[0],
    mockSdk: { apiOrigin: "https://localhost:9446", vppOrigin: "https://localhost:9444", callbackOrigin: "https://localhost:9445" },
  });
  assert.equal(readMockConfig({ ...mockEnv, AGENTIC_MOCK_API_URL: "http://agentic-api-e2e:8081" }).apiUrl, "http://agentic-api-e2e:8081");
  for (const env of [
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { AGENTIC_VISA_EU_CALLBACK_URL: "https://callback.invalid" },
    { VGS_CLIENT_SECRET: "do-not-print" }, { VGS_API_URL: "https://api.example" }, { NETLIFY_AUTH_TOKEN: "do-not-print" },
    { AGENTIC_MOCK_MODE: "true" }, { AGENTIC_MOCK_API_URL: "https://api.visa.com" },
    { AGENTIC_MOCK_SIMULATOR_URL: "http://simulator-unapproved:9999" },
    { AGENTIC_MOCK_VPP_ORIGIN: "https://localhost.evil.example" },
    { AGENTIC_MOCK_VPP_ORIGIN: "http://localhost:9444" },
    { AGENTIC_MOCK_VPP_ORIGIN: "https://secret@localhost:9444" },
    { AGENTIC_MOCK_API_URL: "http://localhost:9999/redirect" },
  ]) assert.throws(() => readMockConfig({ ...mockEnv, ...env }), (error) => !error.message.includes("do-not-print"));
});

test("synthetic cards use real local API enrollment once and retain provider state", async (t) => {
  const config = readMockConfig(mockEnv);
  const calls = [];
  let enrollmentStarted;
  const started = new Promise((resolve) => { enrollmentStarted = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const enrollment = { data: { id: "synthetic-token", attributes: {
    consumer_id: "synthetic-consumer", device_id: "synthetic-device", cardholder_verification: "passkey",
    provision: { status: "PENDING_STEP_UP" },
  } } };
  const app = express();
  app.use(express.json());
  installMockRoutes(app, { mockConfig: config, callVgs: async (...args) => {
    calls.push(args);
    if (args[2] === "/mock/scenario") return { status: 200, data: MOCK_SCENARIOS.find((item) => item.scenario === args[3].scenario) };
    if (args[2] === "/mock/cards") return { status: 201, data: { data: {
      id: "synthetic-card", type: "cards", attributes: { card_brand: "VISA", last4: "1000", pan: "synthetic-pan-must-not-return", cvc: "synthetic-cvc" },
    } } };
    enrollmentStarted();
    await gate;
    return { status: 201, data: enrollment };
  } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/api/mock/cards", { pan: "forbidden" })).status, 400);
  assert.equal(calls.length, 0);
  const cardResponse = await post("/api/mock/cards");
  assert.equal(cardResponse.status, 201);
  const card = await cardResponse.json();
  assert.equal(card.data.data.id, "synthetic-card");
  assert.equal(JSON.stringify(card).includes("synthetic-pan"), false);
  assert.deepEqual(calls[1], [config.simulatorUrl, "POST", "/mock/cards", { network: "visa", scenario: "eu-web" }]);
  assert.equal((await post("/api/cards/unknown-card/agentic-tokens")).status, 404);
  const requests = [post("/api/cards/synthetic-card/agentic-tokens"), post("/api/cards/synthetic-card/agentic-tokens")];
  await started;
  assert.equal(calls.length, 3);
  release();
  for (const response of await Promise.all(requests)) assert.deepEqual(await response.json(), enrollment);
  assert.deepEqual(calls[2], [config.apiUrl, "POST", "/cards/synthetic-card/agentic-tokens", {
    data: { type: "agentic_tokens", attributes: { consumer_email: "buyer@example.test", visa_flow: "v1" } },
  }]);
  assert.deepEqual(await (await post("/api/cards/synthetic-card/agentic-tokens")).json(), enrollment);
  assert.equal(calls.length, 3);
  const saved = await (await fetch(`${base}/api/mock/cards`)).json();
  assert.deepEqual(saved.cards[0].enrollment, enrollment);
});

test("mock API client skips dotenv and never logs synthetic access tokens or request evidence", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const cwd = await mkdtemp(join(tmpdir(), "mock-config-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".env"), "VGS_CLIENT_SECRET=dotenv-must-not-load\nVGS_API_URL=https://provider.invalid\n");
  const script = `
    import assert from 'node:assert/strict';
    const calls = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(options.redirect, 'error');
      calls.push(url);
      return new Response(JSON.stringify(url.endsWith('/mock/oauth/token')
        ? {access_token:'synthetic-access-do-not-log', expires_in:3600} : {data:{id:'synthetic-card'}}),
        {status:200, headers:{'Content-Type':'application/json'}});
    };
    const client = await import(${JSON.stringify(new URL("../vgs.js", import.meta.url).href)});
    assert.equal(process.env.VGS_CLIENT_SECRET, undefined);
    await client.callVgs(client.config.apiUrl, 'POST', '/cards/synthetic-card/agentic-tokens', {fido:'synthetic-fido-do-not-log'});
    assert.deepEqual(calls, ['http://localhost:9999/mock/oauth/token', 'https://localhost:9446/cards/synthetic-card/agentic-tokens']);
    await assert.rejects(client.callVgs('https://provider.invalid', 'POST', '/cards', {}));
    console.log('VERIFIED_LOCAL_ONLY');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd, env: { AGENTIC_MOCK_MODE: "vic-v2-europe" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /VERIFIED_LOCAL_ONLY/);
  for (const secret of ["synthetic-access-do-not-log", "synthetic-fido-do-not-log", "dotenv-must-not-load"]) {
    assert.equal(child.stdout.includes(secret), false);
    assert.equal(child.stderr.includes(secret), false);
  }
});


test("fixture selection forwards all networks and separates enrollment flow caches", async (t) => {
  const config = readMockConfig(mockEnv);
  const calls = [];
  const changed = [];
  let failedScenario = false;
  const app = express();
  app.use(express.json());
  installMockRoutes(app, { mockConfig: config, onScenarioChanged: (name) => changed.push(name), callVgs: async (...args) => {
    calls.push(args);
    const [, , path, body] = args;
    if (path === "/mock/scenario") return { status: failedScenario ? 503 : 200,
      data: MOCK_SCENARIOS.find((item) => item.scenario === body.scenario) };
    if (path === "/mock/cards") return { status: 201, data: { data: { id: body.network + "-card", attributes: {
      card_brand: body.network.toUpperCase(), last4: "1000", exp_month: 12, exp_year: 30,
    } } } };
    return { status: 201, data: { data: { id: `${body.data.attributes.visa_flow}-token`, attributes: body.data.attributes } } };
  } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const input of [{ network: "discover" }, { network: null }, [], { network: "amex", scenario: "visa-otp" }, { network: "visa", pan: "forbidden" }]) {
    assert.equal((await post("/api/mock/cards", input)).status, 400);
  }
  assert.equal((await post("/api/mock/scenario", { scenario: "upstream_error" })).status, 400);
  assert.equal(calls.length, 0);
  for (const network of ["visa", "mastercard", "amex"]) {
    const response = await post("/api/mock/cards", { network });
    assert.equal(response.status, 201);
    const card = await response.json();
    assert.equal(card.card.brand, network.toUpperCase());
    assert.equal(card.card.vaultId, network === "visa" ? "e2e-visa-passkey" : `e2e-${network}`);
  }
  assert.equal((await post("/api/mock/scenario", { scenario: "eu-web" })).status, 200);
  const attrs = { consumer_email: "actual-fixture@example.test", consumer_id: "unchanged-consumer", device_id: "device", visa_flow: "v2" };
  const body = { data: { type: "agentic_tokens", attributes: attrs } };
  const enrollmentPath = "/api/cards/visa-card/agentic-tokens";
  const first = await (await post(enrollmentPath, body)).json();
  assert.deepEqual(first.data.attributes, attrs);
  const legacy = await (await post(enrollmentPath)).json();
  assert.equal(legacy.data.id, "v1-token");
  assert.equal((await (await post(enrollmentPath, body)).json()).data.id, "v2-token");
  assert.equal(calls.filter((item) => item[2] === "/cards/visa-card/agentic-tokens").length, 2);
  failedScenario = true;
  assert.equal((await post("/api/mock/scenario", { scenario: "visa-otp" })).status, 502);
  const selected = await (await fetch(base + "/api/mock/scenario")).json();
  assert.equal(selected.scenario, "eu-web");
  assert.equal(changed.at(-1), "eu-web");
  assert.equal(mockBrowserConfig(config).mockScenario.scenario, "eu-web");
});

test("mock auth profile changes invalidate cached tokens and cannot select an arbitrary vault", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `
    import assert from 'node:assert/strict';
    const profiles = [];
    globalThis.fetch = async (url, options) => {
      profiles.push(new URLSearchParams(options.body).get('profile'));
      return new Response(JSON.stringify({access_token:'synthetic-' + profiles.at(-1),expires_in:3600}),
        {status:200,headers:{'Content-Type':'application/json'}});
    };
    const client = await import(${JSON.stringify(new URL("../vgs.js", import.meta.url).href)});
    await client.getAccessToken(); await client.getAccessToken();
    client.setMockProfile('mastercard'); await client.getAccessToken();
    assert.equal(client.config.vaultId, 'e2e-mastercard');
    client.setMockProfile('visa-otp'); await client.getAccessToken();
    assert.equal(client.config.vaultId, 'e2e-visa-idv');
    assert.throws(() => client.setMockProfile('unconfigured-vault'));
    assert.deepEqual(profiles,['eu-web','mastercard','visa-otp']);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { AGENTIC_MOCK_MODE: "vic-v2-europe" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});


test("fixture switching fails before upstream calls without local auth configuration", async (t) => {
  const app = express();
  app.use(express.json());
  let calls = 0;
  installMockRoutes(app, { mockConfig: { ...readMockConfig(mockEnv), authUrl: null },
    callVgs: async () => { calls++; throw new Error("Unexpected upstream call"); } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mock/scenario`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario: "mastercard" }),
  });
  assert.equal(response.status, 502);
  assert.equal(calls, 0);
});


test("empty MCP fixture input retains the active compatible EU profile", async (t) => {
  const config = readMockConfig(mockEnv);
  const calls = [];
  const app = express();
  app.use(express.json());
  installMockRoutes(app, { mockConfig: config, callVgs: async (...args) => {
    calls.push(args);
    const body = args[3];
    if (args[2] === "/mock/scenario") return { status: 200, data: MOCK_SCENARIOS.find((item) => item.scenario === body.scenario) };
    return { status: 201, data: { data: { id: "mcp-fixture", attributes: {
      card_brand: "VISA", last4: "1000", exp_month: 12, exp_year: 30,
    } } } };
  } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const scenario = "eu-iframe-binding-approved";
  assert.equal((await post("/api/mock/scenario", { scenario })).status, 200);
  const created = await post("/api/mock/cards", {});
  assert.equal(created.status, 201);
  assert.equal((await created.json()).card.scenario, scenario);
  assert.deepEqual(calls.at(-1), [config.simulatorUrl, "POST", "/mock/cards", { network: "visa", scenario }]);
  assert.equal((await (await fetch(base + "/api/mock/scenario")).json()).scenario, scenario);
  assert.equal(mockBrowserConfig(config).mockScenario.scenario, scenario);
});
