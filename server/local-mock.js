import { installMockMerchantRoutes } from "./mock-merchant.js";

const profile = (scenario, network, providerMode, vaultId, browserSupported, description) => Object.freeze({
  scenario, network, providerMode, vaultId, browserSupported, description, simulated: true,
});
export const MOCK_SCENARIOS = Object.freeze([
  ...["eu-web", "eu-existing-passkey", "eu-binding-approved", "eu-iframe-existing-passkey", "eu-iframe-binding-approved"].map((name) =>
    profile(name, "visa", name, "e2e-visa-passkey", !["eu-existing-passkey", "eu-binding-approved"].includes(name),
      name.includes("iframe") ? "Simulated iframe-guide context; provider acceptance remains unverified."
        : name === "eu-web" ? "Simulated EU issuer WEB challenge."
          : "VTS authenticationRequest context; browser mapping is unsupported.")),
  profile("visa-passkey", "visa", "ok", "e2e-visa-passkey", false, "Legacy API fixture; its passkey browser context is unsupported."),
  profile("visa-otp", "visa", "ok", "e2e-visa-idv", true, "Simulated OTP verification with the existing IDV tenant."),
  profile("visa-waiver", "visa", "ok", "e2e-visa-exempt", true, "Existing passkey-exempt tenant fixture."),
  profile("mastercard", "mastercard", "ok", "e2e-mastercard", true, "Existing Mastercard enrollment and credential fixture."),
  profile("amex", "amex", "ok", "e2e-amex", true, "Existing Amex enrollment and credential fixture."),
  profile("amex-enrollment-step-up", "amex", "amex_enrollment_step_up", "e2e-amex", true, "Existing Amex enrollment OTP fixture."),
  profile("amex-credential-step-up", "amex", "amex_credential_step_up", "e2e-amex", true, "Existing Amex credential OTP fixture."),
]);
const profiles = new Map(MOCK_SCENARIOS.map((item) => [item.scenario, item]));
const selectedProfiles = new WeakMap();
export const getMockProfile = (config) => selectedProfiles.get(config) ?? profiles.get("eu-web");
export function selectMockProfile(config, scenario) {
  const selected = profiles.get(scenario);
  if (!config || !selected) throw new Error("Unknown local fixture profile.");
  selectedProfiles.set(config, selected);
  return selected;
}
export function mockBrowserConfig(config) {
  if (!config) return { mockMode: null };
  return {
    mockMode: config.mode, mockScenarios: MOCK_SCENARIOS, mockScenario: getMockProfile(config),
    mockSdk: { apiOrigin: config.browserApiOrigin, vppOrigin: config.vppOrigin, callbackOrigin: config.callbackOrigin },
  };
}

export function installMockRoutes(app, { mockConfig, callVgs, onScenarioChanged }) {
  if (!mockConfig) return null;
  installMockMerchantRoutes(app);
  const cards = new Map();
  const enrollments = new Map();
  const pendingEnrollments = new Map();
  async function activate(scenario) {
    const selected = profiles.get(scenario);
    if (!selected || !mockConfig.authUrl) throw new Error("Unknown local fixture profile or authentication configuration.");
    const result = await callVgs(mockConfig.simulatorUrl, "POST", "/mock/scenario", { scenario });
    if (result.status !== 200 || result.data?.scenario !== scenario || result.data?.vaultId !== selected.vaultId
        || result.data?.network !== selected.network || result.data?.providerMode !== selected.providerMode) {
      throw new Error("Local fixture profile did not change.");
    }
    await onScenarioChanged?.(scenario);
    return selectMockProfile(mockConfig, scenario);
  }
  app.get("/api/mock/scenario", (_req, res) => res.json(getMockProfile(mockConfig)));
  app.post("/api/mock/scenario", async (req, res) => {
    if (!req.body || Object.keys(req.body).length !== 1 || !profiles.has(req.body.scenario)) {
      return res.status(400).json({ error: "unknown_mock_scenario" });
    }
    try { res.json(await activate(req.body.scenario)); }
    catch { res.status(502).json({ error: "mock_scenario_change_failed" }); }
  });
  app.get("/api/mock/cards", (_req, res) => res.json({ simulated: true, cards: [...cards.values()] }));
  app.post("/api/mock/cards", async (req, res) => {
    const input = req.body ?? {};
    if (Array.isArray(input) || typeof input !== "object"
        || (Object.hasOwn(input, "network") && typeof input.network !== "string")
        || (Object.hasOwn(input, "scenario") && typeof input.scenario !== "string")) {
      return res.status(400).json({ error: "invalid_mock_card_fixture" });
    }
    const network = input.network ?? "visa";
    const current = getMockProfile(mockConfig);
    const scenario = input.scenario ?? (current.network === network ? current.scenario
      : ({ visa: "eu-web", mastercard: "mastercard", amex: "amex" })[network]);
    const selected = profiles.get(scenario);
    if (Object.keys(input).some((key) => !["network", "scenario"].includes(key)) || !selected || selected.network !== network) {
      return res.status(400).json({ error: "invalid_mock_card_fixture" });
    }
    try {
      await activate(scenario);
      const { status, data } = await callVgs(mockConfig.simulatorUrl, "POST", "/mock/cards", { network, scenario });
      const resource = data?.data?.data ?? data?.data;
      if (status !== 201 || !resource?.id) throw new Error("Invalid local fixture card response.");
      const brand = { visa: "VISA", mastercard: "MASTERCARD", amex: "AMEX" }[network];
      if (resource.attributes?.card_brand !== brand) throw new Error("Local fixture card network mismatch.");
      const surface = { id: resource.id, type: "cards", attributes: {
        last4: resource.attributes?.last4, exp_month: resource.attributes?.exp_month,
        exp_year: resource.attributes?.exp_year, card_brand: brand,
      } };
      const card = cards.get(resource.id) ?? { cardId: resource.id, lastFour: surface.attributes.last4,
        brand, network, scenario, vaultId: selected.vaultId, enrollment: null, simulated: true };
      cards.set(card.cardId, card);
      res.status(201).json({ simulated: true, data: { data: surface }, card });
    } catch { res.status(502).json({ error: "mock_card_creation_failed" }); }
  });
  app.post("/api/cards/:cardId/agentic-tokens", async (req, res) => {
    const card = cards.get(req.params.cardId);
    if (!card) return res.status(404).json({ error: "unknown_mock_card" });
    const selected = getMockProfile(mockConfig);
    if (selected.network !== card.network || selected.vaultId !== card.vaultId) {
      return res.status(409).json({ error: "activate_card_fixture_before_enrollment" });
    }
    const supplied = req.body ?? {};
    const body = { ...supplied, data: { ...supplied.data, type: supplied.data?.type ?? "agentic_tokens",
      attributes: { consumer_email: "buyer@example.test", visa_flow: "v1", ...supplied.data?.attributes } } };
    const key = JSON.stringify([card.cardId, selected.scenario, body.data.attributes.visa_flow]);
    if (enrollments.has(key)) { card.enrollment = enrollments.get(key); return res.status(200).json(card.enrollment); }
    try {
      let pending = pendingEnrollments.get(key);
      if (!pending) {
        pending = callVgs(mockConfig.apiUrl, "POST", `/cards/${encodeURIComponent(card.cardId)}/agentic-tokens`, body);
        pendingEnrollments.set(key, pending);
      }
      const { status, data } = await pending;
      if (status >= 200 && status < 300 && data?.data?.id) { card.enrollment = data; enrollments.set(key, data); }
      res.status(status).json(data);
    } catch { res.status(502).json({ error: "mock_enrollment_failed" }); }
    finally { pendingEnrollments.delete(key); }
  });
  return cards;
}
