import { sendOrVerifyOtp } from "../../server/otp.js";
import { json, wrap } from "./_lib.js";

// The original path carries the opaque method identifier; decode once, then the
// shared proxy encodes it as a single upstream path segment.
export default wrap(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const url = new URL(req.url);
  let body, identifier;
  try {
    body = await req.json();
    const match = url.pathname.match(/\/api\/otp\/(.+)$/);
    identifier = match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return json(400, { error: "Invalid JSON request or method identifier" });
  }
  const { status, data } = await sendOrVerifyOtp(url.searchParams.get("tokenId"), identifier, body);
  return json(status, data);
});
