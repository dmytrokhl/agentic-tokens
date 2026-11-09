const MODE = "vic-v2-europe";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SERVICES = new Set(["agentic-api-e2e", "provider-simulator"]);

function localUrl(value, browser = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Mock endpoint URL is invalid."); }
  const allowed = LOOPBACK.has(url.hostname) || (!browser && SERVICES.has(url.hostname));
  if (!allowed || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !["http:", "https:"].includes(url.protocol) || (browser && url.protocol !== "https:")) {
    throw new Error("Mock endpoints must use approved local origins.");
  }
  return url.origin;
}

export function readMockConfig(env = process.env) {
  if (!env.AGENTIC_MOCK_MODE) return null;
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("Mock mode requires trusted TLS certificates.");
  if (env.AGENTIC_MOCK_MODE !== MODE) throw new Error("Unsupported AGENTIC_MOCK_MODE.");
  const forbidden = Object.keys(env).filter((key) => env[key] && (
    key.startsWith("VGS_") || /^(NETLIFY_|AGENTIC_API_BASE_URL$|AGENTIC_APP_BASE_URL$|AGENTIC_VISA_EU_CALLBACK_URL$)/.test(key)
  ));
  if (forbidden.length) throw new Error(`Mock mode cannot use provider or hosting configuration: ${forbidden.join(", ")}`);
  const apiUrl = localUrl(env.AGENTIC_MOCK_API_URL || "https://localhost:9446");
  const simulatorUrl = localUrl(env.AGENTIC_MOCK_SIMULATOR_URL || "http://localhost:9999");
  return Object.freeze({
    mode: MODE,
    merchantOrigin: localUrl(env.AGENTIC_MOCK_MERCHANT_ORIGIN || "https://localhost:4200", true),
    apiUrl,
    simulatorUrl,
    authUrl: `${simulatorUrl}/mock/oauth/token`,
    browserApiOrigin: localUrl(env.AGENTIC_MOCK_BROWSER_API_ORIGIN || "https://localhost:9446", true),
    vppOrigin: localUrl(env.AGENTIC_MOCK_VPP_ORIGIN || "https://localhost:9444", true),
    callbackOrigin: localUrl(env.AGENTIC_MOCK_CALLBACK_ORIGIN || "https://localhost:9445", true),
  });
}
