import { deliverCallback } from "./callback.js";
import { trustedFrontendOrigins } from "./config.js";

const status = document.getElementById("status")!;
try {
  deliverCallback(window, [window.location.origin, ...trustedFrontendOrigins]);
  status.textContent = "Verification returned. You can close this window.";
} catch {
  history.replaceState(null, "", location.pathname);
  status.textContent = "Verification could not return. Restart verification in the original window.";
}
