/**
 * Cardholder OTP flow over the Visa-compatible public contract.
 *
 * This is the whole client side of the ID&V flow, deliberately kept in one file with no
 * dependency on the VGS auth library. Visa obtains options with the first call; a provider
 * may instead return the same `stepUpRequest` shape with enrollment.
 *
 *   1. getStepUpOptions()   — which methods are available (Mastercard, or Visa when not preloaded)
 *   2. requestOtp()         — send the code via the chosen method
 *   3. submitOtp()          — verify the code (this completes ID&V)
 *   4. completeEnrollment() — finish enrolling the token, now that ID&V passed
 *
 * For Visa, completeEnrollment() must follow submitOtp() when enrollment is required,
 * before creating intents. Amex and Mastercard continue directly to payment credentials after OTP.
 *
 * Every call goes to *this app's own backend* (`/api/...`), which forwards it to the VGS
 * API with server-side credentials — see `server/server.js`. Keep it that way in your own
 * integration: the browser never needs VGS credentials for this flow.
 *
 * The `clientRefId` ties the calls together. Visa clients generate it once with
 * `newClientRefId()`. Mastercard starts with `newClientRefId("mastercard")`, keeps that
 * lookup reference for delivery/resends, and uses the latest returned reference for verification.
 *
 * Contrast with the passkey flow (`vgs-agentic-auth.js` + `DeviceBinding.tsx`), where the
 * library manages a Visa iframe and returns `assuranceData` for intent creation.
 */

/** One verification method offered for the token. */
export interface OtpMethod {
  /** e.g. "OTPSMS", "OTPEMAIL". */
  method: string;
  /** Opaque id — pass it to requestOtp(). */
  identifier: string;
  /** Masked destination, safe to show the cardholder (e.g. "**PSMS"). */
  value?: string;
}

/** Result of step 1. */
export interface StepUpOptions {
  /** Step-up status, typically "CHALLENGE". */
  status?: string;
  /**
   * Whether the FIDO passkey ceremony is required. `false` confirms the vault is on the
   * ID&V flow. If you ever see `true` here, the vault is configured for the passkey flow
   * and you should use the library instead.
   */
  passkeyRequired: boolean;
  /** Offered methods, filtered to real OTP methods (see isOtpMethod). */
  methods: OtpMethod[];
  /** Raw response, for display/debugging. */
  raw: unknown;
}

/** HTTP errors retain the complete API body for the demo's response panel. */
export class IdvError extends Error {
  status?: number;
  code?: string;
  body?: unknown;
  constructor(message: string, opts: { status?: number; code?: string; body?: unknown } = {}) {
    super(message);
    this.name = "IdvError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

/** Summary for inline errors and flow decisions; not the API response payload. */
export function idvErrorInfo(err: unknown): { error: string; code?: string; status?: number } {
  if (err instanceof IdvError) return { error: err.message, code: err.code, status: err.status };
  return { error: err instanceof Error ? err.message : String(err) };
}

/** Show the actual API body, including unknown fields and nested diagnostics. */
export function idvErrorPayload(err: unknown): unknown {
  return err instanceof IdvError && err.status !== undefined ? err.body : idvErrorInfo(err);
}

/** A fresh lookup reference; Mastercard delivery returns a separate verification reference. */
export function newClientRefId(network?: string): string {
  return (network === "mastercard" ? "vgs:ms:v1:" : "") + crypto.randomUUID();
}

/**
 * Keep only methods you can actually deliver a code with. The card network may include
 * placeholder or non-OTP entries (the sandbox returns one), so filter rather than
 * assuming a fixed set or trusting the order.
 */
export function isOtpMethod(m: OtpMethod): boolean {
  return Boolean(m) && typeof m.method === "string" && m.method.startsWith("OTP")
    && typeof m.identifier === "string" && Boolean(m.identifier);
}

/** Call this app's backend, which proxies to the VGS API. */
async function call<T = unknown>(method: string, path: string, body?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new IdvError(`Network error: ${(err as Error).message}`);
  }

  const raw = await res.text();
  let data: unknown = raw || null;
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { /* Keep non-JSON responses visible as received. */ }
  }
  if (!res.ok) {
    // The VGS error envelope is { error, detail, meta: { observability: { trace_id … } } }.
    // Quote trace_id to VGS support when something fails upstream.
    const envelope = record(data) ? data : {};
    throw new IdvError(
      typeof envelope.detail === "string" ? envelope.detail
        : typeof envelope.error === "string" ? envelope.error : res.statusText,
      { status: res.status, code: typeof envelope.error === "string" ? envelope.error : undefined, body: data },
    );
  }
  return data as T;
}

/**
 * Step 1 — GET /agentic-tokens/{tokenId}/step-up-options
 *
 * Ask which verification methods the cardholder has. Show the masked `value` of each
 * method and keep the `identifier` of the one they pick.
 */
export async function getStepUpOptions(tokenId: string, clientRefId: string): Promise<StepUpOptions> {
  const query = new URLSearchParams({ tokenId, clientRefId });
  const data = await call<{
    data?: { attributes?: { status?: string; passkey_required?: boolean; stepUpRequest?: OtpMethod[] } };
  }>("GET", `/step-up-options?${query}`);

  const attrs = data?.data?.attributes ?? {};
  return {
    status: attrs.status,
    // Absent means "run the passkey" — only an explicit false is the ID&V flow.
    passkeyRequired: attrs.passkey_required !== false,
    methods: Array.isArray(attrs.stepUpRequest) ? attrs.stepUpRequest.filter(isOtpMethod) : [],
    raw: data,
  };
}

/**
 * Step 2 — POST /agentic-tokens/{tokenId}/otp/{identifier}
 *
 * Ask the network to deliver a code via the chosen method. Call again to resend.
 */
export async function requestOtp(tokenId: string, clientRefId: string, identifier: string): Promise<unknown> {
  return call("POST", `/otp/${encodeURIComponent(identifier)}?tokenId=${encodeURIComponent(tokenId)}`, {
    data: {
      type: "otp_methods",
      attributes: { client_ref_id: clientRefId },
    },
  });
}

/**
 * Step 3 — POST /agentic-tokens/{tokenId}/otp
 *
 * Verify the code. HTTP 200 alone is not verification: inspect the returned status
 * with readOtpVerification(), and preserve any new client_ref_id for the next attempt.
 *
 * `session_context` / `browser_data` are required by the endpoint but empty in this flow:
 * they exist to carry data collected by the passkey flow's iframe, which we don't have.
 */
export async function submitOtp(
  tokenId: string,
  clientRefId: string,
  consumerEmail: string,
  otp: string,
): Promise<unknown> {
  return call("POST", `/otp?tokenId=${encodeURIComponent(tokenId)}`, {
    data: {
      type: "otp_submissions",
      attributes: {
        otp,
        client_ref_id: clientRefId,
        consumer_email: consumerEmail,
        session_context: {},
        browser_data: {},
      },
    },
  });
}

/**
 * Step 4 — POST /agentic-tokens/{tokenId}/agentic-enrollments
 *
 * Finish enrolling the token now that the cardholder is verified. Call once per token,
 * after submitOtp() and before creating any intent. Use the same `consumer_email` you
 * enrolled the card with.
 */
export async function completeEnrollment(tokenId: string, consumerEmail: string): Promise<unknown> {
  return call("POST", `/agentic-enrollments?tokenId=${encodeURIComponent(tokenId)}`, {
    data: {
      type: "agentic_enrollments",
      attributes: { consumer_email: consumerEmail },
    },
  });
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function otpAttributes(body: unknown, type: string, id: string): Record<string, unknown> {
  if (!record(body) || !record(body.data) || body.data.type !== type || body.data.id !== id
    || !record(body.data.attributes)) throw new IdvError("Unexpected verification response. Please try again.");
  return body.data.attributes;
}

/** Delivery retains the original reference for resends, and returns a separate verification reference. */
export function readOtpDelivery(body: unknown, identifier: string, originalRef: string): string {
  const attrs = otpAttributes(body, "otp_methods", identifier);
  const next = attrs.client_ref_id;
  if (originalRef.startsWith("vgs:ms:")) {
    if (typeof next !== "string" || !next.startsWith("vgs:ms:v1:") || next === originalRef) {
      throw new IdvError("The verification session was not returned. Get new verification options.");
    }
  }
  return typeof next === "string" && next ? next : originalRef;
}

export function readOtpVerification(body: unknown, tokenId: string, currentRef: string): {
  status: "verified" | "pending" | "rejected";
  clientRefId: string;
} {
  const attrs = otpAttributes(body, "otp_submissions", tokenId);
  const mastercard = currentRef.startsWith("vgs:ms:");
  const next = attrs.client_ref_id;
  if (attrs.status === "PENDING" && mastercard
    && (typeof next !== "string" || !next.startsWith("vgs:ms:v1:"))) {
    throw new IdvError("The verification session was not returned. Get new verification options.");
  }
  const verified = mastercard ? attrs.status === "VALIDATED"
    : ["VALIDATED", "APPROVED", "AUTHENTICATED", "ACTIVE"].includes(String(attrs.status));
  if (!verified && !["PENDING", "PENDING_STEP_UP", "REJECTED", "FAILED", "DECLINED", "EXPIRED"].includes(String(attrs.status))) {
    throw new IdvError("Verification could not be confirmed. Please try again.");
  }
  return {
    status: verified ? "verified" : ["PENDING", "PENDING_STEP_UP"].includes(String(attrs.status)) ? "pending" : "rejected",
    clientRefId: typeof next === "string" && next ? next : currentRef,
  };
}

export function otpMethodLabel(method: OtpMethod): string {
  const label = ({ OTPSMS: "SMS", OTPEMAIL: "Email" } as Record<string, string>)[method.method] ?? method.method;
  return method.value ? `${label} — ${method.value}` : label;
}
