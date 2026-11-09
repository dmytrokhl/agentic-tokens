import { apiResponse, type AppConfig } from "./api.ts";
import { visaProvisioningStatus, type FlowFactory, type PreparationSession, type VisaProvision } from "./preparation.ts";

export interface EuropeEnrollment {
  tokenId: string;
  provisioningStatus: string | null;
  cardholderVerification: string | null;
  consumerId?: string;
  deviceId?: string;
}

export function sandboxCallbackUrl(config: AppConfig, origin: string): string {
  if (config.mockMode || config.vaultEnv !== "sandbox") {
    throw new Error("This journey requires the VGS sandbox runtime.");
  }
  if (config.visaEnvironment === null) throw new Error("The configured API does not have a supported sandbox browser environment.");
  if (config.visaEnvironment === "local" && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
    throw new Error("Open the local API demo on localhost for browser verification.");
  }
  const url = new URL(config.visaEuCallbackUrl || "/visa-3ds-callback.html", origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTPS verification callback without query parameters.");
  }
  return url.href;
}

export async function enrollEuropeCard(cardId: string, consumerEmail: string): Promise<EuropeEnrollment> {
  const response = await apiResponse<{
    data?: { id?: string; attributes?: { consumer_id?: string; device_id?: string; cardholder_verification?: string; provision?: VisaProvision } };
  }>("POST", `/cards/${encodeURIComponent(cardId)}/agentic-tokens`, {
    data: { type: "agentic_tokens", attributes: { consumer_email: consumerEmail, visa_flow: "v2" } },
  });
  if (!response.ok || !response.body?.data?.id) {
    throw new Error(`Visa v2 enrollment failed (HTTP ${response.status}). Check the sandbox card and vault configuration.`);
  }
  const { id, attributes } = response.body.data;
  return {
    tokenId: id,
    provisioningStatus: visaProvisioningStatus(attributes?.provision),
    cardholderVerification: attributes?.cardholder_verification ?? null,
    ...(attributes?.consumer_id ? { consumerId: attributes.consumer_id } : {}),
    ...(typeof attributes?.device_id === "string" && attributes.device_id ? { deviceId: attributes.device_id } : {}),
  };
}

export async function removeEuropeDeviceBinding(tokenId: string, deviceId: string): Promise<"APPROVED" | "CHALLENGE" | "REJECTED"> {
  if (!tokenId.trim() || !/^[A-Za-z0-9_-]{1,24}$/.test(deviceId.trim())) {
    throw new Error("Enter the device ID used for this token (up to 24 letters, digits, hyphens, or underscores).");
  }
  const query = new URLSearchParams({ tokenId: tokenId.trim(), deviceId: deviceId.trim() });
  let response;
  try {
    response = await apiResponse<{ data?: { attributes?: { result?: string } } }>("DELETE", `/device-bindings?${query}`);
  } catch {
    throw new Error("Device removal outcome unavailable. Check the API before trying again.");
  }
  if (!response.ok) throw new Error(`Visa device removal failed (HTTP ${response.status}). Removal was not confirmed.`);
  const result = response.body?.data?.attributes?.result;
  if (result !== "APPROVED" && result !== "CHALLENGE" && result !== "REJECTED") {
    throw new Error("Visa returned no supported removal result. Removal was not confirmed.");
  }
  return result;
}

export interface VerificationContext { amount: string; currencyCode: string; merchantName: string; merchantUrl: string }

export function sandboxVerificationContext(amount: string, currencyCode: string, merchantName: string, merchantUrl: string): VerificationContext {
  if (!/^[0-9]{1,7}(\.[0-9]{1,2})?$/.test(amount) || !/^[0-9]{3}$/.test(currencyCode) || !merchantName.trim()) {
    throw new Error("Enter a verification amount, three-digit currency code, and merchant name.");
  }
  const url = new URL(merchantUrl);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("Enter an HTTPS merchant URL without credentials.");
  const encodedLength = (value: string) => Math.ceil(new TextEncoder().encode(value).length * 4 / 3);
  if (encodedLength(merchantName.trim()) > 2048 || encodedLength(url.href) > 512) throw new Error("The merchant name or URL exceeds Visa's encoded length limit.");
  return { amount, currencyCode, merchantName: merchantName.trim(), merchantUrl: url.href };
}

export async function prepareSandboxCard(
  enrollment: EuropeEnrollment, consumerEmail: string, config: AppConfig, origin: string,
  container: HTMLElement, accessToken: string, createFlow: FlowFactory, getCheckoutContext: () => string,
  verification: VerificationContext, startDeviceBinding = false, registrationOnly = false,
): Promise<PreparationSession> {
  const verified = sandboxVerificationContext(verification.amount, verification.currencyCode, verification.merchantName, verification.merchantUrl);
  const flow = createFlow({
    tokenId: enrollment.tokenId,
    environment: config.visaEnvironment ?? "sandbox",
    consumerEmail,
    accessToken,
    clientRefId: crypto.randomUUID(),
    timeout: 180_000,
    preparationMode: "vic-v2-europe",
    startDeviceBinding,
    registrationOnly,
    callbackUrl: sandboxCallbackUrl(config, origin),
    checkoutContext: getCheckoutContext(),
    getCheckoutContext,
    authenticationAmount: verified.amount, currencyCode: verified.currencyCode, merchantName: verified.merchantName, merchantUrl: verified.merchantUrl,
  });
  return flow.startSession(container);
}

export async function completeSandboxThreeDs(session: PreparationSession): Promise<void> {
  if (session.preparationState !== "web_challenge_pending" || !session.authenticate) {
    throw new Error("Visa has not requested a browser 3DS challenge for this session.");
  }
  const result = await session.authenticate();
  if (!result || typeof result !== "object" || !("status" in result) || result.status !== "registration_ready") {
    throw new Error("The issuer verification did not return a supported completion result.");
  }
}
