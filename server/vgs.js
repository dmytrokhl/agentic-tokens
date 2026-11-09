import { config as loadEnv } from "dotenv";
import { readMockConfig } from "./mock-config.js";
import { getMockProfile, selectMockProfile } from "./local-mock.js";

export const mockConfig = readMockConfig();
if (!mockConfig) loadEnv();

// Shared VGS API client.
// Used by the Express server (Docker) and by Netlify Functions.

const VGS_API_URL = mockConfig?.apiUrl || process.env.VGS_API_URL || "https://gw-01-sandbox.vgsapi.com";
const VGS_CMP_API_URL = mockConfig?.simulatorUrl || process.env.VGS_CMP_API_URL || "https://sandbox.vgsapi.com";
const VGS_CLIENT_ID = process.env.VGS_CLIENT_ID || "";
const VGS_CLIENT_SECRET = process.env.VGS_CLIENT_SECRET || "";
const VGS_AUTH_URL =
  mockConfig?.authUrl || process.env.VGS_AUTH_URL ||
  "https://auth.verygoodsecurity.com/auth/realms/vgs/protocol/openid-connect/token";
const VGS_VAULT_ID = process.env.VGS_VAULT_ID || "";
const VGS_VAULT_ENV = process.env.VGS_VAULT_ENV || "sandbox";

export const config = {
  apiUrl: VGS_API_URL,
  cmpApiUrl: VGS_CMP_API_URL,
  get vaultId() { return mockConfig ? getMockProfile(mockConfig).vaultId : VGS_VAULT_ID; },
  vaultEnv: VGS_VAULT_ENV,
};

let accessToken = null;
let tokenExpiresAt = 0;
let tokenProfile = null;

export function setMockProfile(scenario) {
  if (!mockConfig) throw new Error("Local fixture profiles require mock mode.");
  selectMockProfile(mockConfig, scenario);
  accessToken = null;
  tokenExpiresAt = 0;
  tokenProfile = null;
}

export async function getAccessToken() {
  const profile = mockConfig ? getMockProfile(mockConfig).scenario : null;
  if (accessToken && Date.now() < tokenExpiresAt && (!mockConfig || tokenProfile === profile)) {
    return accessToken;
  }

  console.log(`→ AUTH ${VGS_AUTH_URL}`);
  const res = await fetch(VGS_AUTH_URL, {
    ...(mockConfig && { redirect: "error" }),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: VGS_CLIENT_ID,
      client_secret: VGS_CLIENT_SECRET,
      grant_type: "client_credentials",
      ...(mockConfig && { profile }),
    }),
  });

  if (!res.ok) {
    throw new Error(`Auth failed (${res.status}).`);
  }

  const data = await res.json();
  if (mockConfig && getMockProfile(mockConfig).scenario !== profile) {
    throw new Error("The local fixture changed during authentication. Retry with the selected fixture.");
  }
  accessToken = data.access_token;
  tokenProfile = profile;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log("← Access token obtained, expires in", data.expires_in, "s");
  return accessToken;
}

export async function callVgs(baseUrl, method, path, body, { sensitive = false } = {}) {
  if (mockConfig) {
    if (![mockConfig.apiUrl, mockConfig.simulatorUrl].includes(baseUrl)
        || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
      throw new Error("Mock requests must use the local API or simulator.");
    }
  }
  const profile = mockConfig ? getMockProfile(mockConfig).scenario : null;
  // Local fixture controls must work after a provider reset, before a new tenant token is available.
  const fixtureControl = mockConfig && baseUrl === mockConfig.simulatorUrl && path === "/mock/scenario";
  const token = fixtureControl ? null : await getAccessToken();
  if (mockConfig && getMockProfile(mockConfig).scenario !== profile) {
    throw new Error("The local fixture changed before the request. Retry with the selected fixture.");
  }
  const url = `${baseUrl}${path}`;
  const logPath = sensitive ? path.split("?")[0].replace(/(\/otp)\/.+$/, "$1/[REDACTED]") : path;
  const logUrl = `${baseUrl}${logPath}`;
  console.log(`→ ${method} ${logUrl}`);
  let res;
  try {
    res = await fetch(url, {
      ...(mockConfig && { redirect: "error" }),
      method,
      headers: {
        "Content-Type": "application/vnd.api+json",
        ...(token && { Authorization: `Bearer ${token}` }),
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
  console.log(`← ${res.status} ${method} ${logPath}`);
  return { status: res.status, data };
}

export function hasCredentials() {
  return Boolean(mockConfig || (VGS_CLIENT_ID && VGS_CLIENT_SECRET));
}
