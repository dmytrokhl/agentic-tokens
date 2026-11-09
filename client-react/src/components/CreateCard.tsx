import { useEffect, useRef, useState } from "react";
import { fetchAccessToken, fetchConfig, loadCollectJs } from "../api";
import { useAppState, useStepStatus } from "../useAppState";
import { DEFAULT_NETWORK, NETWORK_META, networkFromCardType, type Network } from "../flow";
import { Step } from "./Step";
import { Field, Row, Button } from "./ui";

const FIELD_CSS = {
  "font-size": "14px",
  "font-family": "ui-sans-serif, system-ui, sans-serif",
  color: "#1f2937",
  "&::placeholder": { color: "#9ca3af" },
};

type CardOption = "visa1" | "visa2" | "mastercard" | "mastercardIdv" | "amexTest1" | "amexTest2" | "amex" | "amexOtp" | "visaEu3ds" | "custom";

interface TestCard {
  id: CardOption;
  label: string;
  pan: string;
  cvv: string;
  exp: string;
  network: Network;
}

const TEST_CARDS: TestCard[] = [
  { id: "visa1", label: "Visa — ...1569 / CVV 814 / 12/27", pan: "4622943123121569", cvv: "814", exp: "12 / 27", network: "visa" },
  { id: "visa2", label: "Visa — ...1478 / CVV 845 / 12/27", pan: "4622943123121478", cvv: "845", exp: "12 / 27", network: "visa" },
  { id: "visaEu3ds", label: "Visa — ...0040 / CVV 449 / 12/27 / (EU 3DS)", pan: "4395840142700040", cvv: "449", exp: "12 / 27", network: "visa" },
  { id: "mastercard", label: "Mastercard — ...4574 / CVV 123 / 12/27", pan: "2222690420064574", cvv: "123", exp: "12 / 27", network: "mastercard" },
  { id: "mastercardIdv", label: "Mastercard — ...3496 / CVV 123 / 12/27", pan: "5387980000003496", cvv: "123", exp: "12 / 27", network: "mastercard" },
  { id: "amexTest1", label: "Amex — ...1009 / CID 1111 / 12/27 (Test 1)", pan: "378685943191009", cvv: "1111", exp: "12 / 27", network: "amex" },
  { id: "amexTest2", label: "Amex — ...1005 / CID 1111 / 12/27 (Test 2)", pan: "379258102641005", cvv: "1111", exp: "12 / 27", network: "amex" },
  { id: "amex", label: "Amex — ...1003 / CID 1111 / 12/27 (Test 3)", pan: "379258101671003", cvv: "1111", exp: "12 / 27", network: "amex" },
  { id: "amexOtp", label: "Amex — ...1000 / CID 1111 / 12/27 (OTP required)", pan: "379843270071000", cvv: "1111", exp: "12 / 27", network: "amex" },
];

interface CollectCardFormProps {
  loading: boolean;
  onLoading: (loading: boolean) => void;
  onCreated: (card: { cardId: string; network: Network }) => void;
  onResponse: (response: unknown) => void;
  log: (message: string) => void;
  visaOnly?: boolean;
  currentCard?: { cardId: string; network: Network };
}

export function CollectCardForm({ loading, onLoading, onCreated, onResponse, log, visaOnly = false, currentCard }: CollectCardFormProps) {
  const [created, setCreated] = useState<{ cardId: string; network: Network } | null>(null);
  const displayedCard = currentCard ?? created;
  const [option, setOption] = useState<CardOption>(visaOnly ? "custom" : "mastercardIdv");
  const [formInitialized, setFormInitialized] = useState(false);
  // Latest card type reported by Collect.js — used to detect the network for
  // custom PANs entered in the secure iframe (preset cards use their known PAN).
  const cardTypeRef = useRef<string | null>(null);
  // Derived "ready" state — set after fields for the current option finish loading.
  // Comparing against the live `option` keeps the button disabled while remounting,
  // without a synchronous setState in the effect body.
  const [readyForOption, setReadyForOption] = useState<CardOption | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const formRef = useRef<VgsCollectForm | null>(null);
  const fieldsRef = useRef<{
    number?: VgsCollectField;
    cvc?: VgsCollectField;
    exp?: VgsCollectField;
  }>({});

  const fieldsReady = readyForOption === option;

  // Create the Collect form once on mount.
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const cfg = await fetchConfig();
        if (cancelled) return;
        if (!cfg.vaultId) {
          setInitError("VGS_VAULT_ID is not configured on the server.");
          return;
        }
        await loadCollectJs(cfg.collectJsUrl);
        if (!window.VGSCollect) {
          setInitError("VGS Collect.js failed to load.");
          return;
        }

        const form = await window.VGSCollect.session({
          vaultId: cfg.vaultId,
          env: cfg.vaultEnv,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateCallback: (formState: any) => {
            // Capture the card brand Collect detects from the typed PAN so we
            // can resolve the network even when the PAN lives in the iframe.
            for (const key in formState) {
              const ct = formState[key]?.cardType;
              if (ct && ct !== "unknown") cardTypeRef.current = ct;
            }
          },
          authHandler: async () => await fetchAccessToken(),
        });
        if (cancelled) {
          form?.destroy?.();
          return;
        }
        formRef.current = form;
        setFormInitialized(true);
      } catch (err) {
        if (!cancelled) {
          setInitError("Failed to initialize Collect.js: " + (err as Error).message);
        }
      }
    }

    init();
    return () => {
      cancelled = true;
      formRef.current?.destroy?.();
      formRef.current = null;
    };
  }, []);

  // (Re)create fields whenever the selected option changes.
  // For card1/card2 — fields are created with prefillValue and prefilled after load.
  // For custom — fields are created empty.
  useEffect(() => {
    if (!formInitialized || !formRef.current) return;
    let cancelled = false;

    // Tear down any existing fields so the iframes remount cleanly with new options.
    fieldsRef.current.number?.delete();
    fieldsRef.current.cvc?.delete();
    fieldsRef.current.exp?.delete();
    fieldsRef.current = {};

    const card = TEST_CARDS.find((c) => c.id === option);
    const form = formRef.current;

    const numberField = form.cardNumberField("#cc-number", {
      placeholder: "Card number",
      css: FIELD_CSS,
      showCardIcon: true,
      ...(card?.pan && { prefillValue: card.pan }),
    });
    const cvcField = form.cardCVCField("#cc-cvc", {
      placeholder: "CVV",
      css: FIELD_CSS,
      ...(card?.cvv && { prefillValue: card.cvv }),
    });
    const expField = form.cardExpirationDateField("#cc-exp", {
      placeholder: "MM / YY",
      yearLength: 2,
      css: FIELD_CSS,
      ...(card?.exp && { prefillValue: card.exp }),
    });
    fieldsRef.current = { number: numberField, cvc: cvcField, exp: expField };

    Promise.all([numberField.promise, cvcField.promise, expField.promise]).then(() => {
      if (cancelled) return;
      if (card?.pan) numberField.prefill();
      if (card?.cvv) cvcField.prefill();
      if (card?.exp) expField.prefill();
      setReadyForOption(option);
    });

    return () => {
      cancelled = true;
    };
  }, [formInitialized, option]);

  // Resolve the network from the selected preset, or — for a custom card — from
  // the brand Collect detected. Falls back to the default when undetectable; the
  // enroll response is the authoritative confirmation (see EnrollToken).
  function resolveNetwork(): Network {
    const preset = TEST_CARDS.find((c) => c.id === option);
    if (preset) return preset.network;
    return networkFromCardType(cardTypeRef.current) ?? DEFAULT_NETWORK;
  }

  async function handleCreate() {
    const form = formRef.current;
    if (!form) return;
    onLoading(true);
    log("Creating card via Collect.js…");
    try {
      const network = resolveNetwork();
      if (visaOnly && (option === "custom" || option === "visaEu3ds") && networkFromCardType(cardTypeRef.current) !== "visa") {
        throw new Error("Use a Visa test card for the Europe journey.");
      }
      const result = await form.createCard();
      onResponse(result);
      const cardId = result?.data?.data?.id;
      if (cardId) {
        const card = { cardId, network };
        setCreated(card);
        log(`Card created — ${cardId} (${network})`);
        onCreated(card);
      } else {
        log("Card creation failed. Check the response.");
        onLoading(false);
      }
    } catch (err) {
      log("Card creation failed.");
      onResponse({ error: visaOnly ? "Card creation failed. Check your Visa test card and retry." : (err as Error).message });
      onLoading(false);
    }
  }

  return (
    <>
      {initError && (
        <div className="bg-red-50 border border-red-300 text-red-700 text-sm rounded p-2 mb-2">
          {initError}
        </div>
      )}

      {displayedCard && (
        <div className="text-sm mb-1">
          Detected network:{" "}
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${NETWORK_META[displayedCard.network].badgeCss}`}>
            {NETWORK_META[displayedCard.network].label}
          </span>
        </div>
      )}

      <Field label="Card Selection">
        <select
          className="input"
          value={option}
          disabled={loading}
          onChange={(e) => { cardTypeRef.current = null; setOption(e.target.value as CardOption); }}
        >
          {TEST_CARDS.filter((card) => !visaOnly || card.network === "visa").map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
          <option value="custom">Enter your own card</option>
        </select>
      </Field>

      <Field label="Card Number">
        <div id="cc-number" className="input collect-field min-h-[36px] flex items-center" />
      </Field>
      <Row>
        <Field label="Expiration">
          <div id="cc-exp" className="input collect-field min-h-[36px] flex items-center" />
        </Field>
        <Field label="CVV">
          <div id="cc-cvc" className="input collect-field min-h-[36px] flex items-center" />
        </Field>
      </Row>

      <Button onClick={handleCreate} disabled={!fieldsReady || loading}>
        {fieldsReady ? "Create Card" : "Loading Collect.js…"}
      </Button>
    </>
  );
}

export function CreateCard() {
  const { state, setState, log, setLoading, completeStep } = useAppState();
  const { loading, num } = useStepStatus("card");
  const [response, setResponse] = useState<unknown>(null);
  return <Step stepKey="card" title="Create Card (VGS Collect)" response={response}>
    <CollectCardForm loading={loading} onLoading={(value) => setLoading("card", value)} onResponse={setResponse}
      currentCard={state.cardId ? { cardId: state.cardId, network: state.network } : undefined}
      log={(message) => log(`Step ${num}: ${message}`)} onCreated={({ cardId, network }) => {
        setState((state) => ({ ...state, cardId, network, tokenId: null, otpContext: null, otpVerifiedTokenId: null,
          intentId: null, assuranceData: null, cardholderVerification: null, agenticEnrollmentRequired: false,
          completedSteps: new Set(),
        }));
        completeStep("card");
      }} />
  </Step>;
}
