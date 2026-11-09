import { v2Path } from "../../server/v2-adapter.js";
import { callVgs, config } from "../../server/vgs.js";
import { json, wrap } from "./_lib.js";

// POST /api/confirmations — confirm transaction outcome
export default wrap(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("visaFlow") === "v2") {
    let path;
    try { path = v2Path("confirmations", req.method, url.searchParams); }
    catch (error) { return json(error.status || 400, { error: error.message }); }
    const body = await req.json().catch(() => undefined);
    const { status, data } = await callVgs(config.apiUrl, req.method, path, body);
    return json(status, data);
  }
  const tokenId = url.searchParams.get("tokenId");
  const intentId = url.searchParams.get("intentId");
  const body = await req.json().catch(() => undefined);
  const { status, data } = await callVgs(
    config.apiUrl, "POST",
    `/agentic-tokens/${tokenId}/intents/${intentId}/confirmations`,
    body
  );
  return json(status, data);
});
