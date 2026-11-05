/**
 * Per-network configuration for the demo. This file is the single place that
 * knows how each card network behaves — adding a network (e.g. amex, discover)
 * is a matter of extending the `Record<Network, …>` tables below, and TypeScript
 * will flag every table that's still missing an entry. Components must consume
 * these tables / helpers rather than testing `network === "visa"` directly.
 */

/** Card networks the demo supports. */
export type Network = "visa" | "mastercard" | "amex";

/** Stable identifier for each step, independent of its position in a flow. */
export type StepKey =
  | "card"
  | "enroll"
  | "otpOptions"
  | "deviceBinding"
  | "idv"
  | "agenticEnroll"
  | "intent"
  | "cryptogram"
  | "confirm"
  | "deleteEnrollment";

/**
 * How the cardholder must be verified, straight from the enroll response's
 * `data.attributes.cardholder_verification`. The server decides this from the vault's
 * configuration, so the client never guesses or probes:
 *
 *  - "passkey" — FIDO passkey ceremony in a Visa iframe, driven by the VGS auth library
 *    (`vgs-agentic-auth.js`). Produces `assurance_data` for intent creation. Visa may ask
 *    for a one-time code first; that's reported per attempt on the device-attestation
 *    response (`session.needsOtp`), not here.
 *  - "otp"     — passkey-exempt cardholder ID&V: a one-time passcode driven
 *    server-to-server, no iframe and no `assurance_data`. See `src/idv.ts`.
 *  - "none"    — no cardholder verification step at all (unchallenged Amex and Visa
 *    vaults that waive both the passkey and ID&V).
 *
 * Absent from an older response means "passkey" — the behaviour the API had before the
 * field existed.
 */
export type CardholderVerification = "passkey" | "otp" | "none";

/** Assumed until the enroll response says otherwise (matches the API's own default). */
export const DEFAULT_CARDHOLDER_VERIFICATION: CardholderVerification = "passkey";

/**
 * Read the two flow facts off an enroll response. Kept here, next to the types that declare
 * them, so the field names and their defaults live in one place rather than in the component
 * that happens to make the call. An unrecognised value falls back to the default.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function flowFromEnrollResponse(enrollResponse: any): {
  verification: CardholderVerification;
  agenticEnrollmentRequired: boolean;
} {
  const attrs = enrollResponse?.data?.attributes ?? {};
  const reported = attrs.cardholder_verification;
  return {
    // Validated against the meta table below rather than a hand-written list, so a new
    // verification mode is a compile error in one place instead of silently falling back here.
    verification: Object.hasOwn(CARDHOLDER_VERIFICATION_META, reported ?? "")
      ? reported
      : DEFAULT_CARDHOLDER_VERIFICATION,
    agenticEnrollmentRequired: attrs.agentic_enrollment_required === true,
  };
}

/**
 * Which optional phases of the flow each network runs. This is what replaced the old
 * fixed `FLOWS` table. Visa confirmation follows the cryptogram; Amex also shows a manual cleanup block.
 *  - `enrollment`   — the post-enroll cardholder-verification / complete-enrollment phase.
 *  - `intent`       — spending intents ("verifiable intent" isn't enabled upstream for
 *    Mastercard SCOF or Amex ACE yet).
 *  - `confirmation` — reporting the outcome back (card-scoped checkout needs none).
 *  - `deletion`     — optional user-triggered cleanup, available as soon as enrollment succeeds.
 * See docs/temporary-mc-user-guide.md in the maranui repo for the Mastercard shape.
 */
const NETWORK_PHASES: Record<Network, { enrollment: boolean; intent: boolean; confirmation: boolean; deletion: boolean }> = {
  visa: { enrollment: true, intent: true, confirmation: true, deletion: false },
  mastercard: { enrollment: false, intent: false, confirmation: false, deletion: false },
  amex: { enrollment: false, intent: false, confirmation: false, deletion: true },
};

/**
 * The ordered steps of the active flow. The displayed step number and the gating order are
 * derived from this list.
 *
 * Composed from the network's phases plus the two enroll-response fields rather than a fixed
 * table, because they are independent facts: `cardholder_verification` decides *which*
 * verification step runs (if any), and `agentic_enrollment_required` decides whether the extra
 * enrollment call is needed. Every combination is therefore handled, including a Visa vault
 * that waives verification entirely.
 *
 * The Mastercard demo always exercises shared OTP, with a separate options step.
 * Amex adds ID&V only when enrollment explicitly requests OTP; older responses keep
 * the direct enrollment-to-credential flow.
 *
 * `verification` is null until the enroll response reports it; the default applies until then.
 */
export function stepsFor(
  network: Network,
  verification: CardholderVerification | null,
  agenticEnrollmentRequired: boolean,
): StepKey[] {
  const phases = NETWORK_PHASES[network];
  const steps: StepKey[] = ["card", "enroll"];
  if (network === "mastercard") steps.push("otpOptions", "idv");
  if (phases.enrollment) {
    const v = verification ?? DEFAULT_CARDHOLDER_VERIFICATION;
    if (v === "passkey") steps.push("deviceBinding");
    if (v === "otp") steps.push("idv");
    if (agenticEnrollmentRequired) steps.push("agenticEnroll");
  } else if (network === "amex" && verification === "otp") {
    steps.push("idv");
  }
  if (phases.intent) steps.push("intent");
  steps.push("cryptogram");
  if (phases.confirmation) steps.push("confirm");
  if (phases.deletion) steps.push("deleteEnrollment");
  return steps;
}

/** Labels and badge classes for the read-only flow indicator in the app header. */
export const CARDHOLDER_VERIFICATION_META: Record<
  CardholderVerification,
  { label: string; badgeCss: string; hint: string }
> = {
  passkey: {
    label: "Passkey (FIDO)",
    badgeCss: "bg-blue-100 text-blue-800",
    hint: "Device binding + passkey ceremony via the VGS auth library; produces assurance_data.",
  },
  otp: {
    label: "One-time code (ID&V)",
    badgeCss: "bg-purple-100 text-purple-800",
    hint: "Verify with a code sent by SMS or email.",
  },
  none: {
    label: "None",
    badgeCss: "bg-green-100 text-green-800",
    hint: "This vault requires no cardholder verification step.",
  },
};

/**
 * How a network's cryptogram is requested, decoupled from the network name:
 *  - "intent" — intent-scoped, with a transaction-data cart (Visa).
 *  - "scof"   — card-scoped SCOF checkout, no intent (Mastercard).
 *  - "amex"   — card-scoped Amex ACE payment credentials, no intent.
 * Mastercard and Amex now share the same public URL; the style still controls
 * the form fields and payload attributes.
 * A new network maps onto one of these styles (or adds a new one, which the
 * `Record<Network, …>` makes TypeScript surface in GetCryptogram).
 */
export type CryptogramStyle = "intent" | "scof" | "amex";
export const CRYPTOGRAM_STYLE: Record<Network, CryptogramStyle> = {
  visa: "intent",
  mastercard: "scof",
  amex: "amex",
};

/** Display metadata for a network — label and Tailwind badge classes. */
export interface NetworkMeta {
  label: string;
  badgeCss: string;
}
export const NETWORK_META: Record<Network, NetworkMeta> = {
  visa: { label: "Visa", badgeCss: "bg-blue-100 text-blue-800" },
  mastercard: { label: "Mastercard · SCOF", badgeCss: "bg-orange-100 text-orange-800" },
  amex: { label: "Amex · ACE", badgeCss: "bg-sky-100 text-sky-800" },
};

/** The network assumed before any detection has run. */
export const DEFAULT_NETWORK: Network = "visa";

/**
 * Map a Collect.js `cardType` string to a Network. Collect reports the brand it
 * detects from the typed PAN; we use it to resolve the network for custom cards
 * entered in the secure iframe. Returns null for brands we don't model yet.
 */
const COLLECT_CARD_TYPES: Record<string, Network> = {
  visa: "visa",
  mastercard: "mastercard",
  "master card": "mastercard",
  amex: "amex",
  "american express": "amex",
  americanexpress: "amex",
  "american-express": "amex",
};
export function networkFromCardType(cardType: string | null | undefined): Network | null {
  return cardType ? COLLECT_CARD_TYPES[cardType.trim().toLowerCase()] ?? null : null;
}

/**
 * Authoritatively reconcile the network from an enroll response, falling back to
 * the PAN-detected `fallback` when the response carries no network-specific
 * marker. Mastercard's SCOF branch returns `enrollment.digital_card_id`; Visa
 * does not. New networks add their own marker check here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reconcileNetwork(enrollResponse: any, fallback: Network): Network {
  if (enrollResponse?.data?.attributes?.enrollment?.digital_card_id) return "mastercard";
  if (enrollResponse?.data?.attributes?.enrollment?.network === "amex") return "amex";
  return fallback;
}
