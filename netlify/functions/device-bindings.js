import { removeDeviceBinding } from "../../server/device-bindings.js";
import { callVgs, config } from "../../server/vgs.js";
import { json } from "./_lib.js";

export default async function handler(req) {
  if (req.method !== "DELETE") return json(405, { error: "Use DELETE to remove a device binding." });
  const params = new URL(req.url).searchParams;
  try {
    const { status, data } = await removeDeviceBinding(params.get("tokenId"), params.get("deviceId"), callVgs, config.apiUrl);
    return json(status, data);
  } catch {
    return json(502, { error: "Device removal outcome unavailable. Check the API before trying again." });
  }
}
