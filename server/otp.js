import { callVgs, config } from "./vgs.js";

function validToken(tokenId) {
  return typeof tokenId === "string" && tokenId.trim() && ![".", ".."].includes(tokenId.trim());
}

async function callOtpApi(method, path, body) {
  try {
    return await callVgs(config.apiUrl, method, path, body, { sensitive: true });
  } catch {
    return { status: 502, data: { error: "Verification request could not be confirmed. No automatic retry was sent." } };
  }
}

export function getOtpOptions(tokenId, clientRefId) {
  if (!validToken(tokenId)) return { status: 400, data: { error: "tokenId required" } };
  if (typeof clientRefId !== "string" || !clientRefId) return { status: 400, data: { error: "clientRefId required" } };
  const query = new URLSearchParams({ client_ref_id: clientRefId });
  return callOtpApi("GET", `/agentic-tokens/${encodeURIComponent(tokenId.trim())}/step-up-options?${query}`);
}

export function sendOrVerifyOtp(tokenId, identifier, body) {
  if (!validToken(tokenId)) return { status: 400, data: { error: "tokenId required" } };
  const delivery = identifier !== undefined;
  const attrs = body?.data?.attributes;
  if ((delivery && (typeof identifier !== "string" || !identifier || [".", ".."].includes(identifier)))
    || body?.data?.type !== (delivery ? "otp_methods" : "otp_submissions")
    || typeof attrs?.client_ref_id !== "string" || !attrs.client_ref_id
    || (!delivery && (typeof attrs?.otp !== "string" || !attrs.otp.trim()))) {
    return { status: 400, data: { error: "Valid verification parameters required" } };
  }
  const path = `/agentic-tokens/${encodeURIComponent(tokenId.trim())}/otp${delivery ? `/${encodeURIComponent(identifier)}` : ""}`;
  return callOtpApi("POST", path, body);
}
