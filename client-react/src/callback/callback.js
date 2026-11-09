function exactOrigin(value) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== value || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) {
    throw new Error("Invalid frontend origin");
  }
  return value;
}

export function deliverCallback(browser, trustedFrontendOrigins) {
  const url = new URL(browser.location.href);
  const keys = ["attempt_id", "frontend_origin", "stepupresponse", "stepupauthcode"];
  if (keys.some((key) => url.searchParams.getAll(key).length > 1)) {
    throw new Error("Duplicate callback parameter");
  }
  const frontendOrigin = exactOrigin(url.searchParams.get("frontend_origin"));
  if (!trustedFrontendOrigins.map(exactOrigin).includes(frontendOrigin)) {
    throw new Error("Frontend origin is not allowed");
  }
  const attempt = url.searchParams.get("attempt_id") || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(attempt)) throw new Error("Invalid callback attempt");
  const result = (url.searchParams.get("stepupresponse") || "").toLowerCase();
  if (!["approved", "declined", "failure"].includes(result)) throw new Error("Invalid verification result");
  const code = url.searchParams.get("stepupauthcode");
  if (code !== null && (!code || result !== "approved")) throw new Error("Invalid authentication code result");
  if (!browser.opener || browser.opener.closed) throw new Error("The original window is unavailable");
  browser.history.replaceState(null, "", url.pathname);
  browser.opener.postMessage({
    type: "vgs:3ds-result", attempt_id: attempt, stepupresponse: result,
    ...(code !== null ? { stepupauthcode: code } : {}),
  }, frontendOrigin);
}
