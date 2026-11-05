import { getOtpOptions } from "../../server/otp.js";
import { json, wrap } from "./_lib.js";

export default wrap(async (req) => {
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });
  const url = new URL(req.url);
  const { status, data } = await getOtpOptions(url.searchParams.get("tokenId"), url.searchParams.get("clientRefId"));
  return json(status, data);
});
