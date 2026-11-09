export class V2AdapterError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function v2Path(operation, method, query) {
  if (query.get("visaFlow") !== "v2") return null;
  const required = (key) => {
    const value = query.get(key);
    if (!value) throw new V2AdapterError(400, `${key} required for Visa v2`);
    return encodeURIComponent(value);
  };
  const base = `/agentic-tokens/v2/cards/${required("cardId")}/${required("tokenId")}`;
  if (operation === "cryptograms" && method === "POST") {
    return query.get("intentId") ? `${base}/intents/${required("intentId")}/cryptograms` : `${base}/cryptograms`;
  }
  if (operation === "confirmations" && method === "POST") return `${base}/intents/${required("intentId")}/confirmations`;
  if (operation === "intents" && method === "DELETE") return `${base}/intents/${required("intentId")}`;
  throw new V2AdapterError(405, "This operation is not supported for Visa v2");
}

export function installV2Routes(app, { callVgs, apiUrl }) {
  for (const operation of ["cryptograms", "confirmations", "intents"]) {
    app.all(`/api/${operation}`, async (req, res, next) => {
      const query = new URL(req.originalUrl, "http://localhost").searchParams;
      if (query.get("visaFlow") !== "v2") return next();
      try {
        const path = v2Path(operation, req.method, query);
        const { status, data } = await callVgs(apiUrl, req.method, path, req.body);
        res.status(status).json(data);
      } catch (error) {
        res.status(error instanceof V2AdapterError ? error.status : 502)
          .json({ error: error instanceof V2AdapterError ? error.message : "Visa v2 request failed" });
      }
    });
  }
}
