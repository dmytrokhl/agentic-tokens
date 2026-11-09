export function installMockMerchantRoutes(app) {
  const requests = new Map();
  const subscriptions = new Map();
  const sessions = new Map();
  const ttl = 10 * 60 * 1000;
  app.post("/api/payment-requests", (req, res) => {
    const body = req.body ?? {};
    if (!body.id || !body.buyerId || !Number.isFinite(body.amount) || body.amount <= 0) {
      return res.status(400).json({ error: "id, buyerId, and positive amount required" });
    }
    if (requests.has(body.id)) return res.status(409).json({ error: "payment_request_exists" });
    if (body.simulatedOutcome && !["APPROVED", "DECLINED", "CANCELLED"].includes(body.simulatedOutcome)) {
      return res.status(400).json({ error: "invalid_simulated_outcome" });
    }
    const record = { id: body.id, buyerId: body.buyerId, amount: body.amount, currency: body.currency ?? "USD",
      ...(body.mandate ? { mandate: body.mandate } : {}),
      simulatedOutcome: body.simulatedOutcome ?? "APPROVED",
      reason: body.reason ?? "Simulated payment", plan: body.plan ?? null, siteId: null,
      simulated: true, status: "pending", createdAt: Date.now(), expiresAt: Date.now() + ttl };
    requests.set(record.id, record);
    res.json(record);
  });
  app.all("/api/payment-requests/:id", (req, res) => {
    const record = requests.get(req.params.id);
    if (!record || (record.status === "pending" && Date.now() > record.expiresAt)) {
      return res.status(404).json({ error: "Payment request not found" });
    }
    if (req.method === "GET") return res.json(record);
    if (req.method === "DELETE") { requests.delete(req.params.id); return res.json({ id: req.params.id, deleted: true }); }
    if (req.method !== "PUT") return res.sendStatus(405);
    const next = { ...record, ...req.body, id: record.id, simulated: true, updatedAt: Date.now() };
    requests.set(record.id, next);
    res.json(next);
  });
  app.all("/api/subscriptions/:buyerId", (req, res) => {
    const buyerId = req.params.buyerId;
    const existing = subscriptions.get(buyerId);
    if (req.method === "GET") return res.json({ buyerId, subscription: existing
      ? { ...existing, active: existing.status === "active", expired: false } : null });
    if (req.method === "DELETE") {
      if (existing) subscriptions.set(buyerId, { ...existing, status: "canceled", canceledAt: Date.now() });
      return res.json({ buyerId, deleted: Boolean(existing) });
    }
    if (req.method !== "POST") return res.sendStatus(405);
    const subscription = { ...existing, ...req.body, buyerId, simulated: true,
      startedAt: existing?.startedAt ?? Date.now(), updatedAt: Date.now(), status: req.body.status ?? existing?.status ?? "active" };
    subscriptions.set(buyerId, subscription);
    res.json({ buyerId, subscription: { ...subscription, active: subscription.status === "active" } });
  });
  app.all("/api/sessions/:id", (req, res) => {
    const existing = sessions.get(req.params.id);
    if (req.method === "GET") return existing && Date.now() < existing.expiresAt
      ? res.json({ status: "completed", ...existing }) : res.status(404).json({ status: "pending" });
    if (req.method !== "POST") return res.sendStatus(405);
    if (existing) return res.status(409).json({ error: "session_already_completed" });
    if (req.params.id.startsWith("binding-") && (req.body.phase !== "PAYMENT" || !req.body.tokenId || !req.body.cardId
        || !Array.isArray(req.body.assuranceData) || !req.body.assuranceData.length)) {
      return res.status(400).json({ error: "payment_evidence_required" });
    }
    sessions.set(req.params.id, { ...req.body, simulated: true, completedAt: Date.now(), expiresAt: Date.now() + ttl });
    res.json({ ok: true, simulated: true });
  });
}
