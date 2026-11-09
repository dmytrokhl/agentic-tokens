import { apiResponse } from "./api.ts";
import type { PreparationSession } from "./preparation.ts";

type Fields = Record<string, unknown>;
export type PaymentEvidence = Fields[];
export const EUROPE_CURRENCIES: Record<string, string> = { EUR: "978", USD: "840", GBP: "826" };
export interface Purchase {
  amount: string; currency: string; currencyCode: string; merchantName: string; merchantUrl: string;
  mandateId: string; referenceId: string; effectiveUntil: string; quantity: number;
}

export function openSourceConsumer(email: string, username: string, country: string, language: string) {
  const countryCode = country.trim().toUpperCase();
  const languageCode = language.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !username.trim()
    || !/^[A-Z]{2}$/.test(countryCode) || !/^[a-z]{2}$/.test(languageCode)) {
    throw new Error("Enter a consumer username, email, two-letter country code, and two-letter language code.");
  }
  return { username: username.trim(), email: email.trim(), country_code: countryCode, language_code: languageCode };
}

export function createEuropePurchase(amount: string, currency: string, merchantName: string, merchantUrl: string,
  quantity: string, effectiveUntil: string): Purchase {
  const count = Number(quantity);
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0
    || !EUROPE_CURRENCIES[currency] || !merchantName.trim() || merchantName.trim().length > 40
    || !Number.isSafeInteger(count) || count < 1 || !(Date.parse(effectiveUntil) > Date.now())) {
    throw new Error("Enter a positive amount, supported currency, merchant name, quantity, and future expiry.");
  }
  const url = new URL(merchantUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Enter an HTTPS merchant URL.");
  return { amount: Number(amount).toFixed(2), currency, currencyCode: EUROPE_CURRENCIES[currency], merchantName: merchantName.trim(),
    merchantUrl: url.href, quantity: count, effectiveUntil: new Date(effectiveUntil).toISOString(),
    mandateId: crypto.randomUUID(), referenceId: crypto.randomUUID() };
}

export function purchaseMandates(purchase: Purchase) {
  return [{ mandate_id: purchase.mandateId, decline_threshold: { amount: Number(purchase.amount), currency_code: purchase.currency },
    effective_until: purchase.effectiveUntil, quantity: purchase.quantity, preferred_merchant_name: purchase.merchantName }];
}

export function purchaseTransaction(purchase: Purchase) {
  return { mandate_id: purchase.mandateId, transaction_reference_id: purchase.referenceId,
    merchant_name: purchase.merchantName, merchant_url: purchase.merchantUrl,
    transaction_amount: { transaction_amount: purchase.amount, transaction_currency_code: purchase.currency } };
}

export function credentialHandoff(purchase: Purchase, operation: "credential" | "retrieve", consumerId?: string) {
  return { operation, signatureTag: "credential-request", ...(consumerId ? { consumerId } : {}),
    purchaseType: "PURCHASE_HITL", mandates: purchaseMandates(purchase), transaction: purchaseTransaction(purchase),
    encryptedInstructionPayload: { mandates: [{ mandateId: purchase.mandateId,
      declineThreshold: { amount: purchase.amount, currencyCode: purchase.currency },
      effectiveUntilTime: String(Math.floor(Date.parse(purchase.effectiveUntil) / 1000)),
      quantity: String(purchase.quantity), preferredMerchantName: purchase.merchantName }],
    merchantName: purchase.merchantName, merchantUrl: purchase.merchantUrl,
    transactionAmount: { transactionAmount: purchase.amount, transactionCurrencyCode: purchase.currency } } };
}

export function requirePaymentEvidence(value: unknown): PaymentEvidence {
  if (!Array.isArray(value) || !value.length || value.some((item) => item?.verificationEntity !== "10"
    || item.verificationMethod !== "23" || !item.methodResults?.fidoAssertionData?.code
    || !item.methodResults?.identifier || !item.methodResults?.dfpSessionId)) {
    throw new Error("Fresh PAYMENT evidence is required. Registration alone cannot authorize this purchase.");
  }
  return value;
}

export async function continueEuropeSession(session: PreparationSession) {
  const phase = session.preparationState;
  if (!["web_challenge_pending", "registration_ready", "authentication_ready", "awaiting_payment"].includes(phase ?? "")
    || !session.authenticate) throw new Error("Visa has not returned a supported verification action.");
  const result = await session.authenticate();
  if (phase === "registration_ready" && result && typeof result === "object" && "status" in result
    && result.status === "registration_complete") return { phase: "prepared" };
  if (Array.isArray(result) && ["authentication_ready", "awaiting_payment"].includes(phase!)) {
    return { phase: "complete", evidence: requirePaymentEvidence(result) };
  }
  const expected = phase === "web_challenge_pending" ? "registration_ready" : phase === "registration_ready" ? "awaiting_payment" : null;
  if (expected && result && typeof result === "object" && "status" in result && result.status === expected) return { phase: expected };
  throw new Error("Visa returned an unsupported verification result.");
}

export function parseAgentInputs(raw: string, operation: string, consumerId?: string): Fields {
  let value: Fields;
  try { value = JSON.parse(raw); } catch { throw new Error("Enter the agent's JSON inputs for this operation."); }
  const credential = ["credential", "retrieve"].includes(operation);
  const allowed = ["agent", "agent_signature", ...(credential ? ["encrypted_instruction"] : []),
    ...(operation === "credential" ? ["consumer", "consumer_id"] : [])];
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some((key) => !allowed.includes(key))
    || typeof value.agent !== "string" || !value.agent.trim() || (credential && (typeof value.encrypted_instruction !== "string" || !value.encrypted_instruction))
    || (consumerId && value.consumer_id && value.consumer_id !== consumerId)) {
    throw new Error("Supply only the agent, applicable signature, sealed instruction, and matching consumer inputs. Do not enter private keys.");
  }
  const signature = value.agent_signature as { input?: { tag?: string } } | undefined;
  if (signature && operation !== "cancel" && signature.input?.tag !== (operation === "confirmation" ? "confirmation-request" : "credential-request")) {
    throw new Error("The agent signature purpose does not match this operation.");
  }
  return value;
}

export class EuropeOutcomeUnknown extends Error {}

export async function submitEuropeOperation(operation: "credential" | "retrieve" | "confirmation" | "cancel",
  cardId: string, tokenId: string, attributes: Fields, intentId?: string): Promise<Fields> {
  const query = new URLSearchParams({ visaFlow: "v2", cardId, tokenId, ...(intentId ? { intentId } : {}) });
  const route = operation === "confirmation" ? "confirmations" : operation === "cancel" ? "intents" : "cryptograms";
  let response;
  try {
    response = await apiResponse<{ data?: { id?: string; attributes?: Fields } }>(operation === "cancel" ? "DELETE" : "POST", `/${route}?${query}`, {
      data: { type: route, attributes },
    });
  } catch { throw new EuropeOutcomeUnknown("The provider outcome is unknown. Reconcile the operation before another request."); }
  if (!response.ok) {
    if (response.status >= 500) throw new EuropeOutcomeUnknown("The provider outcome is unknown. Reconcile the operation before another request.");
    throw new Error(`Visa v2 request failed (HTTP ${response.status}). Check the operation inputs before retrying.`);
  }
  const result = response.body?.data;
  if (!result?.attributes || !result.id) throw new EuropeOutcomeUnknown("The provider returned an incomplete result. Reconcile it before another request.");
  return result.attributes;
}

export function confirmationSummary(attributes: Fields) {
  return { accepted: true, instructionStatus: attributes.status === "ACTIVE" || attributes.status === "COMPLETED"
    ? attributes.status : null };
}

export function credentialSummary(attributes: Fields) {
  const cryptogram = attributes.cryptogram as Fields | undefined;
  const usable = attributes.status === "COMPLETED" && typeof attributes.network_token === "string" && attributes.network_token.length > 0
    && typeof cryptogram?.value === "string" && cryptogram.value.length > 0 && typeof cryptogram.type === "string" && cryptogram.type.length > 0;
  return { status: attributes.status, intentId: attributes.intent_id, consumerId: attributes.consumer_id,
    usable, tokenLast4: typeof attributes.network_token === "string" ? attributes.network_token.slice(-4) : null,
    eci: attributes.eci ?? null };
}
