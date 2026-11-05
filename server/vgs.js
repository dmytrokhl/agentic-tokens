// Shared VGS API client.
// Used by the Express server (Docker) and by Netlify Functions.

const VGS_API_URL = process.env.VGS_API_URL || "https://gw-01-sandbox.vgsapi.com";
const VGS_CMP_API_URL = process.env.VGS_CMP_API_URL || "https://sandbox.vgsapi.com";
const VGS_CLIENT_ID = process.env.VGS_CLIENT_ID || "";
const VGS_CLIENT_SECRET = process.env.VGS_CLIENT_SECRET || "";
const VGS_AUTH_URL =
  process.env.VGS_AUTH_URL ||
  "https://auth.verygoodsecurity.com/auth/realms/vgs/protocol/openid-connect/token";
const VGS_VAULT_ID = process.env.VGS_VAULT_ID || "";
const VGS_VAULT_ENV = process.env.VGS_VAULT_ENV || "sandbox";

export const config = {
  apiUrl: VGS_API_URL,
  cmpApiUrl: VGS_CMP_API_URL,
  vaultId: VGS_VAULT_ID,
  vaultEnv: VGS_VAULT_ENV,
};

let accessToken = null;
let tokenExpiresAt = 0;

export async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  console.log(`→ AUTH ${VGS_AUTH_URL}`);
  const res = await fetch(VGS_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: VGS_CLIENT_ID,
      client_secret: VGS_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log("← Access token obtained, expires in", data.expires_in, "s");
  return accessToken;
}

export async function callVgs(baseUrl, method, path, body, { sensitive = false } = {}) {
  const token = await getAccessToken();
  const url = `${baseUrl}${path}`;
  const logUrl = sensitive ? `${baseUrl}${path.split("?")[0].replace(/(\/otp)\/.+$/, "$1/[REDACTED]")}` : url;
  if (body) {
    console.log(`→ ${method} ${logUrl}\n  Authorization: [REDACTED]\n  body: ${sensitive ? "[sensitive payload omitted]" : formatLogPayload(body)}`);
  } else {
    console.log(`→ ${method} ${logUrl}\n  Authorization: [REDACTED]`);
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${token}`,
      },
      ...(body && { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new Error(`${method} ${logUrl} network failed: ${err.message}`, { cause: err });
  }

  let text = "";
  try {
    text = await res.text();
  } catch (err) {
    throw new Error(`${method} ${logUrl} response read failed: ${err.message}`, { cause: err });
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  console.log(`← ${res.status} ${sensitive ? "[sensitive payload omitted]" : formatLogPayload(data ?? text)}`);
  return { status: res.status, data };
}

export function hasCredentials() {
  return Boolean(VGS_CLIENT_ID && VGS_CLIENT_SECRET);
}

function formatLogPayload(value) {
  const debugMode = process.env.AGENTIC_DEBUG_VGS_RESPONSE ?? "full";
  if (debugMode === "full") {
    return JSON.stringify(redactSensitiveFields(value), null, 2);
  }
  if (debugMode === "unsafe-full" && isSandboxConfig()) {
    return JSON.stringify(value, null, 2);
  }
  if (debugMode === "unsafe-full") {
    return JSON.stringify({
      warning: "AGENTIC_DEBUG_VGS_RESPONSE=unsafe-full is only allowed for sandbox VGS config.",
      payload: redactSensitiveFields(value),
    }, null, 2);
  }

  const cardSummary = summarizeCardPayload(value);
  if (cardSummary) return JSON.stringify(cardSummary);

  const serialized = typeof value === "string"
    ? value
    : JSON.stringify(redactSensitiveFields(value));
  return serialized.substring(0, 500);
}

function summarizeCardPayload(value) {
  if (!value || typeof value !== "object") return null;
  const resource = value?.data?.data ?? value?.data ?? value;
  if (!resource || resource.type !== "cards") return null;

  const attrs = resource.attributes ?? {};
  return {
    data: {
      id: resource.id ?? null,
      type: resource.type,
      attributes: {
        last4: attrs.last4 ?? attrs.last_4 ?? attrs.last_four ?? null,
        exp_month: attrs.exp_month ?? null,
        exp_year: attrs.exp_year ?? null,
        card_brand: attrs.card_brand ?? attrs.brand ?? attrs.cardBrand ?? null,
        card_type: attrs.card_type ?? attrs.cardType ?? null,
        bin: attrs.bin ?? null,
        first8: attrs.first8 ?? null,
      },
    },
  };
}

function redactSensitiveFields(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? "[REDACTED]" : redactSensitiveFields(nested);
  }
  return out;
}

function isSensitiveKey(key) {
  return /^(pan|cvc|cvv|number|card_number|security_code|cryptogram|otp|otpValue|assuranceData|assurance_data|additionalData|methodAttributes|method_attributes)$/i.test(key);
}

function isSandboxConfig() {
  return VGS_VAULT_ENV === "sandbox"
    && VGS_API_URL.includes("sandbox")
    && VGS_CMP_API_URL.includes("sandbox");
}
