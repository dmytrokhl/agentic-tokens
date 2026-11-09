export async function removeDeviceBinding(tokenId, deviceId, callVgs, apiUrl) {
  if (typeof tokenId !== "string" || !tokenId.trim()
      || typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{1,24}$/.test(deviceId.trim())) {
    return { status: 400, data: { error: "A token ID and a valid device ID are required." } };
  }
  return callVgs(apiUrl, "DELETE",
    `/agentic-tokens/${encodeURIComponent(tokenId.trim())}/device-bindings/${encodeURIComponent(deviceId.trim())}`);
}

export function installDeviceBindingRoutes(app, { callVgs, apiUrl }) {
  app.delete("/api/device-bindings", async (req, res) => {
    try {
      const { status, data } = await removeDeviceBinding(req.query.tokenId, req.query.deviceId, callVgs, apiUrl);
      res.status(status).json(data);
    } catch {
      res.status(502).json({ error: "Device removal outcome unavailable. Check the API before trying again." });
    }
  });
}
