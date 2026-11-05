import { useState } from "react";
import { useOtpInput } from "../useOtpInput";
import { paymentOutcome, paymentRiskAttributes, type PaymentChallenge } from "../amex";
import { idvErrorInfo, idvErrorPayload, requestOtp, submitOtp } from "../idv";
import { apiResponse } from "../api";
import { useAppState, useStepStatus } from "../useAppState";
import { CRYPTOGRAM_STYLE } from "../flow";
import { Step } from "./Step";
import { Field, Row, Button } from "./ui";

const CURRENCY_CODES = [
  { value: "840", label: "840 - USD" },
  { value: "978", label: "978 - EUR" },
  { value: "826", label: "826 - GBP" },
  { value: "392", label: "392 - JPY" },
  { value: "036", label: "036 - AUD" },
  { value: "124", label: "124 - CAD" },
] as const;

export function GetCryptogram() {
  const { state, setState, log, setLoading, completeStep } = useAppState();
  const { loading, num } = useStepStatus("cryptogram");
  // Branch on the cryptogram *style*, not the network name, so a new network
  // maps onto an existing flavour (intent-scoped vs SCOF checkout) by config.
  // The two styles differ in request path, body shape, and form fields, so this
  // is the one deliberate exception to flow.ts's "config tables, no branching"
  // rule — a third style would add a branch here rather than just a table entry.
  const cryptogramStyle = CRYPTOGRAM_STYLE[state.network];
  const isScof = cryptogramStyle === "scof";
  const isAmex = cryptogramStyle === "amex";
  const isCardScoped = isAmex || isScof;
  const requiresOtp = isScof || state.cardholderVerification === "otp";
  const idvReady = !requiresOtp || (state.completedSteps.has("idv") && state.otpVerifiedTokenId === state.tokenId);

  // Visa transaction-context (cart) fields.
  const [txnAmount, setTxnAmount] = useState("5.33");
  const [txnCurrency, setTxnCurrency] = useState("USD");
  const [txnMerchant, setTxnMerchant] = useState("Best Buy");
  const [txnCountry, setTxnCountry] = useState("US");
  const [txnUrl, setTxnUrl] = useState("https://www.bestbuy.com");

  // Mastercard SCOF and Amex ACE share amount and currency fields.
  const [cardScopedAmount, setCardScopedAmount] = useState("5.33");
  const [cardScopedCurrency, setCardScopedCurrency] = useState<string>(CURRENCY_CODES[0].value);
  const [cardScopedMerchant, setCardScopedMerchant] = useState("Best Buy");

  const agentPlatform = state.agentContext.llm_platform ?? "OPEN_AI";
  const [userSignOff, setUserSignOff] = useState<"YES" | "NO">("YES");
  const [partnerMethod, setPartnerMethod] = useState<"N" | "U">("N");
  const [challenge, setChallenge] = useState<PaymentChallenge | null>(null);
  const [selectedMethod, setSelectedMethod] = useState("");
  const { otp, setOtp, resetOtp } = useOtpInput();
  const [otpDelivered, setOtpDelivered] = useState(false);
  const [response, setResponse] = useState<unknown>(null);
  const [finalResult, setFinalResult] = useState<unknown>(null);

  async function handleGet() {
    if (!idvReady || state.loadingSteps.size > 0) return;
    setLoading("cryptogram", true);
    log(`Step ${num}: Getting cryptogram...`);
    if (isAmex) setState((s) => {
      const completedSteps = new Set(s.completedSteps);
      completedSteps.delete("cryptogram");
      return { ...s, completedSteps };
    });
    setFinalResult(null);
    setChallenge(null);
    resetOtp();
    setOtpDelivered(false);
    try {
      if (isAmex && (!state.agentContext.agent_name.trim() || !txnUrl.trim())) {
        throw new Error("Provide agent name and merchant URL.");
      }
      const deviceContext = state.amexDeviceContext;
      if (isAmex && (!deviceContext || deviceContext.cardId !== state.cardId)) {
        throw new Error("Enroll this card with device context before requesting an Amex credential.");
      }
      // SCOF checkout is card-scoped with no intent; intent-style is
      // intent-scoped with a transaction-data cart.
      const query = isCardScoped
          ? `/cryptograms?tokenId=${encodeURIComponent(state.tokenId!)}&cardId=${encodeURIComponent(state.cardId!)}`
          : `/cryptograms?tokenId=${encodeURIComponent(state.tokenId!)}&intentId=${encodeURIComponent(state.intentId!)}`;

      const attributes = isCardScoped
        ? {
            transaction_amount: cardScopedAmount,
            transaction_currency_code: cardScopedCurrency,
            ...(isAmex ? {
              ...paymentRiskAttributes(deviceContext!),
              merchant_url: txnUrl,
              agent: {
                agent_name: state.agentContext.agent_name,
                llm_platform: agentPlatform,
              },
              user_sign_off: userSignOff,
              partner_delegated_signoff: { partner_step_up_method: partnerMethod },
            } : { merchant_name: cardScopedMerchant }),
          }
        : {
            transaction_data: [{
              merchant_country_code: txnCountry,
              transaction_amount: {
                transaction_amount: txnAmount,
                transaction_currency_code: txnCurrency,
              },
              merchant_url: txnUrl,
              merchant_name: txnMerchant,
            }],
          };

      const result = await apiResponse<{ data?: { id?: string; attributes?: Record<string, unknown> }; error?: string; detail?: string }>("POST", query, {
        data: { type: "cryptograms", attributes },
      });
      const data = result.body;
      setResponse(data);
      if (!result.ok) {
        log(`Step ${num}: API returned HTTP ${result.status} — ${data?.detail ?? data?.error ?? JSON.stringify(data)}`);
        setLoading("cryptogram", false);
        return;
      }
      if (isAmex) {
        const outcome = paymentOutcome(data);
        if (outcome.challenge) {
          setChallenge(outcome.challenge);
          setSelectedMethod(outcome.challenge.methods[0].identifier);
          log(`Step ${num}: Payment requires cardholder verification`);
          setLoading("cryptogram", false);
        } else {
          setFinalResult(outcome.credential);
          completeStep("cryptogram");
        }
      } else if (data?.data?.id) {
        log(`Step ${num}: Cryptogram received`);
        setFinalResult(data.data.attributes);
        completeStep("cryptogram");
      } else {
        log(`Step ${num}: Failed — ` + JSON.stringify(data));
        setLoading("cryptogram", false);
      }
    } catch (err) {
      setResponse({ error: (err as Error).message });
      log(`Step ${num}: Error — ` + (err as Error).message);
      setLoading("cryptogram", false);
    }
  }

  async function handlePaymentOtp(verify: boolean) {
    if (!challenge) return;
    setLoading("cryptogram", true);
    setResponse(null);
    try {
      if (!verify) {
        setResponse(await requestOtp(state.tokenId!, challenge.clientRefId, selectedMethod));
        setOtpDelivered(true);
      } else {
        const body = await submitOtp(state.tokenId!, challenge.clientRefId, state.consumerEmail, otp.trim()) as {
          data?: { attributes?: { result?: unknown } };
        };
        setResponse(body);
        if (!body.data?.attributes?.result) {
          const message = "OTP was processed but no payment credential was returned. The payment is not complete; inspect the API response before retrying.";
          log(`Step ${num}: ${message}`);
          setLoading("cryptogram", false);
          return;
        }
        const outcome = paymentOutcome({ data: body.data.attributes.result });
        if (!outcome.credential) throw new Error("Payment verification did not return a final credential.");
        setFinalResult(outcome.credential);
        setChallenge(null);
        resetOtp();
        completeStep("cryptogram");
      }
    } catch (err) {
      log(`Step ${num}: ${(err as Error).message}`);
      setResponse((previous: unknown) => idvErrorInfo(err).status !== undefined ? idvErrorPayload(err) : previous ?? idvErrorPayload(err));
    }
    setLoading("cryptogram", false);
  }

  const title = isAmex
    ? "Get Payment Credential (Amex ACE)"
    : isScof
      ? "Checkout — Get Cryptogram (SCOF)"
      : "Get Payment Cryptogram";

  return (
    <>
      <Step stepKey="cryptogram" title={title} response={response}>
        {isCardScoped ? (
          <>
            <Field label={isAmex ? "Enrollment ID" : "Token ID"}>
              <input className="input" readOnly value={state.tokenId ?? ""} />
            </Field>
            <Row>
              <Field label="Transaction Amount">
                <input className="input" value={cardScopedAmount} onChange={(e) => setCardScopedAmount(e.target.value)} />
              </Field>
              <Field label="Currency">
                <select className="input" value={cardScopedCurrency} onChange={(e) => setCardScopedCurrency(e.target.value)}>
                  {CURRENCY_CODES.map((currency) => (
                    <option key={currency.value} value={currency.value}>{currency.label}</option>
                  ))}
                </select>
              </Field>
            </Row>
            {!isAmex && <Field label="Merchant Name">
              <input className="input" value={cardScopedMerchant} onChange={(e) => setCardScopedMerchant(e.target.value)} />
            </Field>}
            <p className="text-xs text-gray-500 mt-1">
              {isAmex ? "Amex ACE" : "SCOF checkout"} runs directly against the enrolled card — no intent binding.
            </p>
          </>
        ) : (
          <>
            <Field label="Intent ID">
              <input className="input" readOnly value={state.intentId ?? ""} />
            </Field>
            <Row>
              <Field label="Transaction Amount">
                <input className="input" value={txnAmount} onChange={(e) => setTxnAmount(e.target.value)} />
              </Field>
              <Field label="Currency">
                <input className="input" value={txnCurrency} onChange={(e) => setTxnCurrency(e.target.value)} />
              </Field>
            </Row>
            <Row>
              <Field label="Merchant Name">
                <input className="input" value={txnMerchant} onChange={(e) => setTxnMerchant(e.target.value)} />
              </Field>
              <Field label="Merchant Country">
                <input className="input" value={txnCountry} onChange={(e) => setTxnCountry(e.target.value)} />
              </Field>
            </Row>
            <Field label="Merchant URL">
              <input className="input" value={txnUrl} onChange={(e) => setTxnUrl(e.target.value)} />
            </Field>
          </>
        )}
        {isAmex && <>
          <Field label="Merchant URL"><input className="input" value={txnUrl} onChange={(e) => setTxnUrl(e.target.value)} /></Field>
          <Field label="Agent name"><input className="input" value={state.agentContext.agent_name} onChange={(e) => setState((s) => ({ ...s, agentContext: { ...s.agentContext, agent_name: e.target.value } }))} /></Field>
          <Field label="Agent platform"><select className="input" value={agentPlatform} onChange={(e) => setState((s) => ({ ...s, agentContext: { ...s.agentContext, llm_platform: e.target.value as typeof agentPlatform } }))}><option value="OPEN_AI">OpenAI</option></select></Field>
          <Field label="Cardholder approved this purchase"><select className="input" value={userSignOff} onChange={(e) => setUserSignOff(e.target.value as typeof userSignOff)}><option value="YES">Yes</option><option value="NO">No</option></select></Field>
          <Field label="Partner authentication"><select className="input" value={partnerMethod} onChange={(e) => setPartnerMethod(e.target.value as typeof partnerMethod)}><option value="N">No partner step-up (user not present)</option><option value="U">Unsuccessful partner step-up</option></select></Field>
          <p className="text-xs text-gray-500 mt-2">This demo does not perform partner SMS, device or passkey authentication. Amex may request its own verification.</p>
        </>}
        {!idvReady && <p className="text-sm text-amber-700">Complete cardholder verification before requesting a payment credential.</p>}
        <Button onClick={handleGet} disabled={state.loadingSteps.size > 0 || Boolean(challenge) || !idvReady}>
          {isAmex ? "Get Credential" : isScof ? "Checkout" : "Get Cryptogram"}
        </Button>
        {challenge && <>
          <Field label="Payment verification method"><select className="input" value={selectedMethod} onChange={(e) => { setSelectedMethod(e.target.value); setOtpDelivered(false); resetOtp(); }}>
            {challenge.methods.map((method) => <option key={method.identifier} value={method.identifier}>{method.method} {method.value}</option>)}
          </select></Field>
          <Button onClick={() => void handlePaymentOtp(false)} disabled={loading}>{otpDelivered ? "Resend code" : "Send code"}</Button>
          {otpDelivered && <>
            <Field label="Payment verification code"><input className="input" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} /></Field>
            <Button onClick={() => void handlePaymentOtp(true)} disabled={loading || !otp.trim()}>Verify payment</Button>
          </>}
          <Button variant="secondary" onClick={() => { setChallenge(null); resetOtp(); setOtpDelivered(false); }} disabled={loading}>Discard pending attempt</Button>
        </>}
      </Step>

      {finalResult && (
        <div className="bg-green-50 border-2 border-green-500 rounded-lg p-4 mt-4">
          <h2 className="text-base font-semibold mb-2">Payment Credential</h2>
          <pre className="bg-[#1e1e1e] text-[#d4d4d4] p-3 rounded text-sm whitespace-pre-wrap break-all">
            {JSON.stringify(finalResult, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}
