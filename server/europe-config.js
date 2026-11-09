export function europeBrowserConfig(env = process.env) {
  const api = new URL(env.VGS_API_URL || "https://gw-01-sandbox.vgsapi.com");
  const local = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(api.hostname);
  const visaEnvironment = local ? "local"
    : api.origin === "https://gw-01-sandbox.vgsapi.io" ? "dev"
      : api.origin === "https://gw-01-sandbox.vgsapi.com" ? "sandbox" : null;
  const value = env.AGENTIC_VISA_EU_CALLBACK_URL;
  if (!value) return { visaEuCallbackUrl: null, visaEnvironment };
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("AGENTIC_VISA_EU_CALLBACK_URL must be an HTTPS callback URL without query parameters.");
  }
  return { visaEuCallbackUrl: url.href, visaEnvironment };
}
