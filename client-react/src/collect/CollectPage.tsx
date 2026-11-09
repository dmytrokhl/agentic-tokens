import { useEffect, useRef, useState } from "react";
import { fetchAccessToken, fetchConfig, loadCollectJs } from "../api";

const FIELD_CSS = {
  "font-size": "14px",
  "font-family": "ui-sans-serif, system-ui, sans-serif",
  color: "#1f2937",
  "&::placeholder": { color: "#9ca3af" },
};

type CardOption = "card1" | "card2" | "custom";

const CARD_BRAND_KEYS = [
  "brand",
  "card_brand",
  "cardBrand",
  "card_network",
  "cardNetwork",
  "payment_network",
  "paymentNetwork",
  "network",
  "scheme",
  "card_scheme",
  "cardScheme",
];

const TEST_CARDS = [
  { id: "card1" as CardOption, label: "Card 1 — ...1569", pan: "4622943123121569", cvv: "814", exp: "12 / 27" },
  { id: "card2" as CardOption, label: "Card 2 — ...1478", pan: "4622943123121478", cvv: "845", exp: "12 / 27" },
];

export function CollectPage() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId") ?? "";
  const buyerId = params.get("buyer_id") ?? "";

  const [status, setStatus] = useState<"loading" | "ready" | "submitting" | "done" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [option, setOption] = useState<CardOption>("card1");
  const [readyForOption, setReadyForOption] = useState<CardOption | null>(null);
  const formRef = useRef<VgsCollectForm | null>(null);
  const fieldsRef = useRef<{ number?: VgsCollectField; cvc?: VgsCollectField; exp?: VgsCollectField }>({});
  const collectStateRef = useRef<VgsCollectForm["state"]>({});

  // Init Collect form once.
  useEffect(() => {
    if (!sessionId) {
      setError("Missing sessionId in URL");
      setStatus("error");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchConfig();
        if (cancelled) return;
        if (cfg.mockMode) throw new Error("Card collection is disabled in local mock mode. Open / to create a synthetic fixture card.");
        if (!cfg.vaultId) throw new Error("VGS vault not configured on server");
        await loadCollectJs(cfg.collectJsUrl);
        if (!window.VGSCollect) throw new Error("Collect.js failed to load");

        const form = await window.VGSCollect.session({
          vaultId: cfg.vaultId,
          env: cfg.vaultEnv,
          stateCallback: (state) => { collectStateRef.current = state; },
          authHandler: async () => await fetchAccessToken(),
        });
        if (cancelled) {
          form?.destroy?.();
          return;
        }
        formRef.current = form;
        setStatus("ready");
      } catch (err) {
        setError((err as Error).message);
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      formRef.current?.destroy?.();
      formRef.current = null;
    };
  }, [sessionId]);

  // (Re)create fields when option changes.
  useEffect(() => {
    if (status !== "ready") return;
    const form = formRef.current;
    if (!form) return;
    let cancelled = false;

    fieldsRef.current.number?.delete();
    fieldsRef.current.cvc?.delete();
    fieldsRef.current.exp?.delete();
    fieldsRef.current = {};

    const card = TEST_CARDS.find((c) => c.id === option);
    const number = form.cardNumberField("#cc-number", {
      placeholder: "Card number", css: FIELD_CSS, showCardIcon: true,
      ...(card && { prefillValue: card.pan }),
    });
    const cvc = form.cardCVCField("#cc-cvc", {
      placeholder: "CVV", css: FIELD_CSS,
      ...(card && { prefillValue: card.cvv }),
    });
    const exp = form.cardExpirationDateField("#cc-exp", {
      placeholder: "MM / YY", yearLength: 2, css: FIELD_CSS,
      ...(card && { prefillValue: card.exp }),
    });
    fieldsRef.current = { number, cvc, exp };

    Promise.all([number.promise, cvc.promise, exp.promise]).then(() => {
      if (cancelled) return;
      if (card) {
        number.prefill();
        cvc.prefill();
        exp.prefill();
      }
      setReadyForOption(option);
    });

    return () => { cancelled = true; };
  }, [status, option]);

  async function handleSubmit() {
    const form = formRef.current;
    if (!form) return;
    setStatus("submitting");
    try {
      const result = await form.createCard();
      const id = result?.data?.data?.id;
      if (!id) throw new Error("Card creation returned no id");
      setCardId(id);

      const surface = extractCardSurface(result, collectStateRef.current);
      debugCardSurface("createCard", surface, result, collectStateRef.current);

      const payload = { cardId: id, buyerId, ...surface };

      // Tell the MCP server (via session bridge) that the card is ready.
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      // Also store directly in the mock merchant catalog so MCP can look it up.
      if (buyerId) {
        await fetch(`/api/merchant/cards/${encodeURIComponent(buyerId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardId: id, ...surface }),
        });
      }
      setStatus("done");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }

  // VGS CMP doesn't standardize the response attribute names across versions,
  // so try a few common ones and fall back to scraping the masked PAN.
  function extractCardSurface(result: VgsCollectCardResult, collectState: VgsCollectForm["state"] = {}): {
    lastFour: string | null;
    brand: string | null;
    expMonth: string | null;
    expYear: string | null;
    bin: string | null;
    first8: string | null;
  } {
    const attrs = (result?.data?.data?.attributes ?? {}) as Record<string, unknown>;
    const bin = stringOrNull(attrs.bin);
    const first8 = stringOrNull(attrs.first8);
    const lastFour =
      (typeof attrs.last4 === "string" && attrs.last4) ||
      (typeof attrs.last_4 === "string" && attrs.last_4) ||
      (typeof attrs.last_four === "string" && attrs.last_four) ||
      (typeof attrs.maskedNumber === "string" && attrs.maskedNumber.slice(-4)) ||
      (typeof attrs.number === "string" && attrs.number.slice(-4)) ||
      null;
    const brand = findFirstStringByKey(
      [attrs, result?.data, collectState],
      CARD_BRAND_KEYS
    ) ?? inferCardBrandFromBin(first8 ?? bin);
    const expMonthRaw =
      attrs.exp_month ?? attrs.expMonth ?? attrs.expiration_month ?? attrs.expirationMonth ?? null;
    const expYearRaw =
      attrs.exp_year ?? attrs.expYear ?? attrs.expiration_year ?? attrs.expirationYear ?? null;
    const expMonth = expMonthRaw != null ? String(expMonthRaw).padStart(2, "0").slice(-2) : null;
    const expYear = expYearRaw != null ? String(expYearRaw).slice(-2) : null;
    return { lastFour: lastFour || null, brand: brand || null, expMonth, expYear, bin, first8 };
  }

  function findFirstStringByKey(sources: unknown[], keys: string[]): string | null {
    const keySet = new Set(keys);
    for (const source of sources) {
      const value = findStringByKey(source, keySet);
      if (value) return value;
    }
    return null;
  }

  function findStringByKey(source: unknown, keys: Set<string>, depth = 0): string | null {
    if (!source || typeof source !== "object" || depth > 5) return null;
    for (const [key, value] of Object.entries(source)) {
      if (keys.has(key) && typeof value === "string" && value.trim()) return value.trim();
      const nested = findStringByKey(value, keys, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  function inferCardBrandFromBin(value: unknown): string | null {
    const digits = String(value ?? "").replace(/\D/g, "");
    if (!digits) return null;
    if (digits.startsWith("4")) return "VISA";
    if (digits.length >= 2) {
      const first2 = Number(digits.slice(0, 2));
      if (first2 >= 51 && first2 <= 55) return "MASTERCARD";
      if (first2 === 34 || first2 === 37) return "AMERICAN-EXPRESS";
    }
    if (digits.length >= 4) {
      const first4 = Number(digits.slice(0, 4));
      if (first4 >= 2221 && first4 <= 2720) return "MASTERCARD";
      if (first4 === 6011) return "DISCOVER";
    }
    if (digits.length >= 3) {
      const first3 = Number(digits.slice(0, 3));
      if (first3 >= 644 && first3 <= 649) return "DISCOVER";
    }
    if (digits.startsWith("65")) return "DISCOVER";
    if (digits.startsWith("35")) return "JCB";
    if (digits.startsWith("62")) return "UNIONPAY";
    return null;
  }

  function stringOrNull(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    return str || null;
  }

  function debugCardSurface(
    stage: string,
    surface: ReturnType<typeof extractCardSurface>,
    result: VgsCollectCardResult,
    collectState: VgsCollectForm["state"]
  ) {
    if (new URLSearchParams(window.location.search).get("debugCard") !== "1") return;
    const attrs = (result?.data?.data?.attributes ?? {}) as Record<string, unknown>;
    console.info("[card-debug]", stage, {
      cardId: result?.data?.data?.id ?? null,
      surface,
      attrBrand: attrs.card_brand ?? attrs.brand ?? attrs.cardBrand ?? null,
      attrLast4: attrs.last4 ?? attrs.last_4 ?? attrs.last_four ?? null,
      attrExpMonth: attrs.exp_month ?? attrs.expMonth ?? null,
      attrExpYear: attrs.exp_year ?? attrs.expYear ?? null,
      attrBin: attrs.bin ?? null,
      attrFirst8: attrs.first8 ?? null,
      collectBrand: findFirstStringByKey([collectState], CARD_BRAND_KEYS),
    });
  }

  const fieldsReady = readyForOption === option;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex items-center justify-center p-6">
      <div className="bg-white rounded-lg shadow max-w-md w-full p-6">
        <h1 className="text-xl font-semibold mb-1">Add a Card</h1>
        <p className="text-sm text-gray-500 mb-4">
          {buyerId ? <>Linking to <code className="font-mono">{buyerId}</code></> : "Card collection"}
        </p>

        {status === "loading" && <div className="text-sm text-gray-500">Loading…</div>}

        {status === "error" && (
          <div className="bg-red-50 border border-red-300 text-red-700 text-sm rounded p-3">
            {error}
          </div>
        )}

        {status === "done" && cardId && (
          <div>
            <div className="bg-green-50 border border-green-300 text-green-700 text-sm rounded p-3 mb-2">
              Card saved.
            </div>
            <div className="text-xs text-gray-500 font-mono break-all">{cardId}</div>
            <p className="text-sm text-gray-500 mt-3">You can close this tab.</p>
          </div>
        )}

        {(status === "ready" || status === "submitting") && (
          <>
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600 mb-1">Card Selection</label>
              <select
                className="input"
                value={option}
                onChange={(e) => setOption(e.target.value as CardOption)}
                disabled={status === "submitting"}
              >
                {TEST_CARDS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                <option value="custom">Enter your own card</option>
              </select>
            </div>

            <div className="mb-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">Card Number</label>
              <div id="cc-number" className="input collect-field min-h-[36px] flex items-center" />
            </div>
            <div className="flex gap-2 mb-4">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">Expiration</label>
                <div id="cc-exp" className="input collect-field min-h-[36px] flex items-center" />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">CVV</label>
                <div id="cc-cvc" className="input collect-field min-h-[36px] flex items-center" />
              </div>
            </div>

            <button
              onClick={handleSubmit}
              disabled={!fieldsReady || status === "submitting"}
              className="w-full bg-blue-600 text-white text-sm font-medium rounded px-4 py-2 hover:bg-blue-700 disabled:bg-gray-300"
            >
              {status === "submitting" ? "Creating…" : fieldsReady ? "Save Card" : "Loading Collect.js…"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
