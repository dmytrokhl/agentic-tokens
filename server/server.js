import { installMockCheckoutRoutes } from "./mock-checkout.js";
import { europeBrowserConfig } from "./europe-config.js";
import express from "express";
import { installV2Routes } from "./v2-adapter.js";
import { installDeviceBindingRoutes } from "./device-bindings.js";
import { config as vgsConfig, callVgs, getAccessToken, hasCredentials, mockConfig, setMockProfile } from "./vgs.js";
import { installMockRoutes, mockBrowserConfig } from "./local-mock.js";
import { enrichCardSurface, enrichMissingCardSurfaces } from "./card-surface.js";
import { getOtpOptions, sendOrVerifyOtp } from "./otp.js";

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use((err, req, res, next) => {
  if (req.path.startsWith("/api/otp") && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON request" });
  }
  next(err);
});
const mockCards = installMockRoutes(app, { mockConfig, callVgs, onScenarioChanged: setMockProfile });
installV2Routes(app, { callVgs, apiUrl: vgsConfig.apiUrl });
installDeviceBindingRoutes(app, { callVgs, apiUrl: vgsConfig.apiUrl });

const PORT = process.env.PORT || 3000;
installMockCheckoutRoutes(app, { mockConfig, cards: mockCards, visaAgent: process.env.AGENTIC_VISA_AGENT, port: PORT });

function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const cause = err.cause ? ` | cause: ${err.cause.code ?? err.cause.message ?? err.cause}` : "";
      console.error(`Error: ${err.message}${cause}`);
      res.status(500).json({ error: err.message, cause: err.cause?.message ?? err.cause?.code });
    }
  };
}

// --- Routes ---

// GET /api/token — get access token for SDK (device binding calls VGS API from the browser)
app.get("/api/token", handler(async (req, res) => {
  const token = await getAccessToken();
  res.json({ access_token: token });
}));

// GET /api/config — runtime config for the browser (vault id, environment)
// Keeps client builds env-agnostic: no Vite rebuild required when the vault changes.
app.get("/api/config", (req, res) => {
  res.json({
    ...mockBrowserConfig(mockConfig),
    ...europeBrowserConfig(),
    vaultId: vgsConfig.vaultId,
    vaultEnv: vgsConfig.vaultEnv,
    collectJsUrl: mockConfig ? "" : process.env.VGS_COLLECT_JS || "https://js.verygoodvault.com/vgs-collect/4.0.0/vgs-collect.js",
  });
});

// NOTE: Step 1 (create card) now lives entirely in the browser via VGS Collect.js.
// The PAN never touches this server, so there is no POST /api/cards proxy here.

// POST /api/cards/:cardId/agentic-tokens — enroll card (Agentic API)
app.post("/api/cards/:cardId/agentic-tokens", handler(async (req, res) => {
  const { status, data } = await callVgs(
    vgsConfig.apiUrl, "POST",
    `/cards/${encodeURIComponent(req.params.cardId)}/agentic-tokens`,
    req.body
  );
  res.status(status).json(data);
}));

// DELETE /api/amex-enrollments?enrollmentId= — user-requested ACE enrollment deletion.
app.delete("/api/amex-enrollments", handler(async (req, res) => {
  const enrollmentId = typeof req.query.enrollmentId === "string" ? req.query.enrollmentId.trim() : "";
  if (!enrollmentId) return res.status(400).json({ error: "enrollmentId required" });
  const { status, data } = await callVgs(
    vgsConfig.apiUrl, "DELETE",
    `/agentic-tokens/${encodeURIComponent(enrollmentId)}`
  );
  res.status(status).json(data);
}));

// Shared Visa / Amex / Mastercard OTP flow.
app.get("/api/step-up-options", handler(async (req, res) => {
  const { status, data } = await getOtpOptions(req.query.tokenId, req.query.clientRefId);
  res.status(status).json(data);
}));

app.post("/api/otp/:identifier", handler(async (req, res) => {
  const { status, data } = await sendOrVerifyOtp(req.query.tokenId, req.params.identifier, req.body);
  res.status(status).json(data);
}));

app.post("/api/otp", handler(async (req, res) => {
  const { status, data } = await sendOrVerifyOtp(req.query.tokenId, undefined, req.body);
  res.status(status).json(data);
}));

// POST /api/agentic-enrollments?tokenId= — finish enrollment after ID&V
app.post("/api/agentic-enrollments", handler(async (req, res) => {
  const { tokenId } = req.query;
  const { status, data } = await callVgs(
    vgsConfig.apiUrl, "POST",
    `/agentic-tokens/${tokenId}/agentic-enrollments`,
    req.body
  );
  res.status(status).json(data);
}));

// POST /api/intents — create intent (Agentic API)
app.post("/api/intents", handler(async (req, res) => {
  const { tokenId } = req.query;
  const { status, data } = await callVgs(
    vgsConfig.apiUrl, "POST",
    `/agentic-tokens/${tokenId}/intents`,
    req.body
  );
  res.status(status).json(data);
}));

// PUT /api/intents — update intent (Agentic API)
app.put("/api/intents", handler(async (req, res) => {
  const { tokenId, intentId } = req.query;
  const { status, data } = await callVgs(
    vgsConfig.apiUrl, "PUT",
    `/agentic-tokens/${tokenId}/intents/${intentId}`,
    req.body
  );
  res.status(status).json(data);
}));

// DELETE /api/intents — cancel intent (Agentic API)
app.delete("/api/intents", handler(async (req, res) => {
  const { tokenId, intentId } = req.query;
  const { status, data } = await callVgs(
    vgsConfig.apiUrl, "DELETE",
    `/agentic-tokens/${tokenId}/intents/${intentId}`,
    req.body
  );
  res.status(status).json(data);
}));

// POST /api/cryptograms — get payment cryptogram (Agentic API)
// Network-specific endpoints behind one route:
//   Visa       — intent-scoped: /agentic-tokens/{tokenId}/intents/{intentId}/cryptograms
//   Mastercard — card-scoped SCOF checkout (no intent): /cards/{cardId}/agentic-tokens/{tokenId}/cryptograms
//   Amex       — card-scoped ACE payment credentials (no intent): /cards/{cardId}/agentic-tokens/{tokenId}/cryptograms
// The caller selects by passing intentId (Visa) or cardId (card-scoped networks).
app.post("/api/cryptograms", handler(async (req, res) => {
  const { tokenId, intentId, cardId } = req.query;
  const path = cardId
    ? `/cards/${cardId}/agentic-tokens/${tokenId}/cryptograms`
    : `/agentic-tokens/${tokenId}/intents/${intentId}/cryptograms`;
  const { status, data } = await callVgs(vgsConfig.apiUrl, "POST", path, req.body);
  res.status(status).json(data);
}));

// POST /api/confirmations — confirm transaction outcome (Agentic API)
app.post("/api/confirmations", handler(async (req, res) => {
  const { tokenId, intentId } = req.query;
  const { status, data } = await callVgs(
    vgsConfig.apiUrl, "POST",
    `/agentic-tokens/${tokenId}/intents/${intentId}/confirmations`,
    req.body
  );
  res.status(status).json(data);
}));

// --- MCP demo bridge (in-memory) ---
// Sessions act as a coordination channel between the MCP server (stdio process)
// and the browser pages it opens (/collect, /binding). The MCP server polls
// GET /api/sessions/:id; the browser POSTs the result there.
const sessions = new Map();

app.post("/api/sessions/:id", (req, res) => {
  sessions.set(req.params.id, { ...req.body, completedAt: Date.now() });
  res.json({ ok: true });
});

app.get("/api/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ status: "pending" });
  res.json({ status: "completed", ...session });
});

// Mock merchant card store: buyer_id → [{cardId, lastFour, brand?, savedAt}].
// Stands in for the customer's own card vault. We never persist PAN/CVV —
// only the opaque VGS cardId plus surface-display metadata.
const merchantCards = new Map();

app.get("/api/merchant/cards/:buyerId", handler(async (req, res) => {
  const cards = merchantCards.get(req.params.buyerId) ?? [];
  const enriched = await enrichMissingCardSurfaces(cards);
  if (enriched.changed) merchantCards.set(req.params.buyerId, enriched.cards);
  res.json({ buyerId: req.params.buyerId, cards: enriched.cards });
}));

app.post("/api/merchant/cards/:buyerId", handler(async (req, res) => {
  const { cardId } = req.body;
  if (!cardId) return res.status(400).json({ error: "cardId required" });
  const surface = await enrichCardSurface(req.body, { force: true });
  debugMerchantCard("save", req.params.buyerId, req.body, surface);
  const existing = merchantCards.get(req.params.buyerId) ?? [];
  // Dedup by cardId — re-saving the same card just refreshes its position.
  const next = existing.filter((c) => c.cardId !== cardId);
  next.unshift({
    cardId: surface.cardId,
    lastFour: surface.lastFour,
    brand: surface.brand,
    expMonth: surface.expMonth,
    expYear: surface.expYear,
    savedAt: Date.now(),
  });
  merchantCards.set(req.params.buyerId, next);
  res.json({ buyerId: req.params.buyerId, cards: next });
}));

app.delete("/api/merchant/cards/:buyerId", (req, res) => {
  const { cardId } = req.query;
  if (cardId) {
    const existing = merchantCards.get(req.params.buyerId) ?? [];
    const next = existing.filter((c) => c.cardId !== cardId);
    const removed = next.length !== existing.length;
    if (next.length) merchantCards.set(req.params.buyerId, next);
    else merchantCards.delete(req.params.buyerId);
    return res.json({ buyerId: req.params.buyerId, cardId, deleted: removed });
  }
  const existed = merchantCards.delete(req.params.buyerId);
  res.json({ buyerId: req.params.buyerId, deleted: existed });
});

app.get("/api/merchant/cards", (req, res) => {
  res.json(Object.fromEntries(merchantCards));
});

function debugMerchantCard(stage, buyerId, body, surface) {
  if (process.env.AGENTIC_DEBUG_CARD_SURFACE !== "true") return;
  console.log(`[merchant-card:${stage}] ${JSON.stringify({
    buyerId,
    input: {
      cardId: body.cardId ?? null,
      lastFour: body.lastFour ?? null,
      brand: body.brand ?? null,
      expMonth: body.expMonth ?? null,
      expYear: body.expYear ?? null,
    },
    surface,
  })}`);
}

// --- Start ---

app.listen(PORT, () => {
  console.log(`Sample app running on port ${PORT}`);
  console.log(`CMP API:     ${vgsConfig.cmpApiUrl}`);
  console.log(`Agentic API: ${vgsConfig.apiUrl}`);
  if (!hasCredentials()) {
    console.warn("WARNING: VGS_CLIENT_ID or VGS_CLIENT_SECRET not set.");
  }
});
