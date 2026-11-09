import type { AppConfig } from "./api";

export interface VisaProvision {
  tokenInfo?: { tokenStatus?: string };
  status?: string;
}

export function visaProvisioningStatus(provision?: VisaProvision): string | null {
  const status = provision?.tokenInfo?.tokenStatus ?? provision?.status;
  return typeof status === "string" && status.trim() ? status : null;
}

export interface MockCard {
  cardId: string;
  lastFour: string;
  brand?: string;
  scenario?: string;
  vaultId?: string;
  enrollment: {
    data: {
      id: string;
      attributes?: {
        device_id?: string;
        consumer_id?: string;
        cardholder_verification?: string;
        agentic_enrollment_required?: boolean;
        provision?: VisaProvision;
      };
    };
  } | null;
}

export interface PreparationSession {
  preparationState?: string;
  authenticate?: () => Promise<unknown>;
  submitSandboxCallbackUrl?: (value: string) => void;
  destroy: () => void;
}

interface PreparationFlow {
  startSession: (container: HTMLElement) => Promise<PreparationSession>;
}

interface PreparationOptions {
  tokenId: string;
  environment: string;
  consumerEmail: string;
  accessToken: string;
  clientRefId: string;
  timeout?: number;
  preparationMode: string;
  startDeviceBinding?: boolean;
  registrationOnly?: boolean;
  mockApiBase?: string;
  mockVppOrigin?: string;
  callbackUrl: string;
  checkoutContext: string;
  getCheckoutContext: () => string;
  authenticationAmount?: string;
  currencyCode?: string;
  merchantName?: string;
  merchantUrl?: string;
  consumerLocale?: string;
}

export type FlowFactory = (options: PreparationOptions) => PreparationFlow;

export async function prepareMockCard(
  card: MockCard, config: AppConfig, container: HTMLElement, accessToken: string, createFlow: FlowFactory,
  getCheckoutContext?: () => string,
): Promise<PreparationSession> {
  if (config.mockMode !== "vic-v2-europe" || !config.mockSdk?.callbackOrigin || !card.enrollment?.data.id) {
    throw new Error("A local mock card enrollment is required.");
  }
  const checkoutContext = getCheckoutContext?.() ?? card.cardId + ':' + card.enrollment.data.id;
  const flow = createFlow({
    tokenId: card.enrollment.data.id,
    environment: "local",
    consumerEmail: "buyer@example.test",
    accessToken,
    clientRefId: crypto.randomUUID(),
    preparationMode: "vic-v2-europe",
    authenticationAmount: "0", currencyCode: "978", merchantName: "Local simulated merchant", merchantUrl: "https://localhost:4200",
    mockApiBase: config.mockSdk.apiOrigin,
    mockVppOrigin: config.mockSdk.vppOrigin,
    callbackUrl: config.mockSdk.callbackOrigin + '/',
    checkoutContext,
    getCheckoutContext: getCheckoutContext ?? (() => checkoutContext),
  });
  return flow.startSession(container);
}

export function preparationMessage(state: string | undefined): string {
  switch (state) {
    case "web_challenge_pending": return "Simulated bank verification is required. Stopped before opening 3DS.";
    case "otp_challenge_pending": return "The provider requires an OTP challenge. Stopped before requesting a code.";
    case "authentication_ready": return "Simulated iframe-guide authentication context is available. Stopped before authentication.";
    case "registration_ready": return "Simulated iframe-guide registration context is available. Stopped before passkey registration.";
    default: return "The provider context is unsupported. Preparation cannot continue.";
  }
}
