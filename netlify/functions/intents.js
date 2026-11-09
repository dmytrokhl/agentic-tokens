import { v2Path } from "../../server/v2-adapter.js";
import { callVgs, config } from "../../server/vgs.js";
import { json, wrap } from "./_lib.js";

// /api/intents — create/update/cancel intent. tokenId (+ intentId for PUT/DELETE) in query.
export default wrap(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("visaFlow") === "v2") {
    let path;
    try { path = v2Path("intents", req.method, url.searchParams); }
    catch (error) { return json(error.status || 400, { error: error.message }); }
    const body = await req.json().catch(() => undefined);
    const { status, data } = await callVgs(config.apiUrl, req.method, path, body);
    return json(status, data);
  }
  const tokenId = url.searchParams.get("tokenId");
  const intentId = url.searchParams.get("intentId");
  const body = req.method === "DELETE" ? undefined : await req.json().catch(() => undefined);

  let method, path;
  if (req.method === "POST") {
    method = "POST";
    path = `/agentic-tokens/${tokenId}/intents`;
  } else if (req.method === "PUT") {
    method = "PUT";
    path = `/agentic-tokens/${tokenId}/intents/${intentId}`;
  } else if (req.method === "DELETE") {
    method = "DELETE";
    path = `/agentic-tokens/${tokenId}/intents/${intentId}`;
  } else {
    return json(405, { error: `Method ${req.method} not allowed` });
  }

  const { status, data } = await callVgs(config.apiUrl, method, path, body);
  return json(status, data);
});
