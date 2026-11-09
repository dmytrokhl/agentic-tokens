import { CurrencyField } from "./CurrencyField";
import { useEffect, useRef, useState } from "react";
import { fetchAccessToken, type AppConfig } from "../api";
import { enrollEuropeCard, prepareSandboxCard, removeEuropeDeviceBinding, sandboxCallbackUrl, sandboxVerificationContext, type EuropeEnrollment } from "../europe-sandbox";
import { continueEuropeSession } from "../europe-payment";
import { EuropeSandboxCheckout, type EuropeCheckoutHandle } from "./EuropeSandboxCheckout";
import type { PreparationSession } from "../preparation";
import { CollectCardForm } from "./CreateCard";
import { EuropeStep } from "./EuropeStep";
import { Log } from "./Log";
import { Button, Field, Row } from "./ui";

export function EuropeSandbox({ config }: { config: AppConfig }) {
  const [activeStep, goToStep] = useState(1);
  const [cardId, setCardId] = useState("");
  const [consumerEmail, setConsumerEmail] = useState("user@example.com");
  const [enrollment, setEnrollment] = useState<EuropeEnrollment | null>(null);
  const [verificationAmount, setVerificationAmount] = useState("1");
  const [verificationCurrency, setVerificationCurrency] = useState("978");
  const [verificationMerchant, setVerificationMerchant] = useState("VGS Sandbox Demo");
  const [verificationUrl, setVerificationUrl] = useState(window.location.origin);
  const [verificationMode, setVerificationMode] = useState("stored-passkey");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [message, setMessage] = useState("Enter your Visa sandbox test card to start.");
  const [manualCallbackUrl, setManualCallbackUrl] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [cardResponse, setCardResponse] = useState<unknown>(null);
  const [deviceId, setDeviceId] = useState("");
  const [removingBinding, setRemovingBinding] = useState(false);
  const [bindingMessage, setBindingMessage] = useState("");
  const checkout = useRef<EuropeCheckoutHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const session = useRef<PreparationSession | null>(null);
  const attempt = useRef(0);
  const context = JSON.stringify([cardId, enrollment?.tokenId, consumerEmail, verificationAmount, verificationCurrency, verificationMerchant, verificationUrl, verificationMode]);
  const currentContext = useRef(context);
  useEffect(() => { currentContext.current = context; }, [context]);
  useEffect(() => () => { attempt.current += 1; session.current?.destroy(); }, []);
  const log = (entry: string) => setLogs((entries) => [...entries, entry]);
  const navigation = { activeStep, goToStep, log };
  const preparationComplete = ["web_challenge_pending", "registration_ready", "authentication_ready", "awaiting_payment", "prepared"].includes(phase);
  let callbackUrl = "";
  let setupError = "";
  try { callbackUrl = sandboxCallbackUrl(config, window.location.origin); }
  catch (error) { setupError = (error as Error).message; }

  function clearSession() {
    attempt.current += 1;
    session.current?.destroy();
    session.current = null;
    setPhase("idle");
    setBusy(false);
    setManualCallbackUrl("");
  }

  async function enroll() {
    clearSession();
    const currentAttempt = attempt.current;
    setBusy(true);
    try {
      const result = await enrollEuropeCard(cardId, consumerEmail.trim());
      if (currentAttempt !== attempt.current) return;
      setEnrollment(result);
      setDeviceId(result.deviceId ?? "");
      setBindingMessage("");
      setMessage("Visa v2 token provisioned. Prepare a fresh browser session for issuer verification.");
      log("Visa v2 enrollment returned. Cardholder verification remains separate.");
      goToStep(3);
    } catch (error) {
      if (currentAttempt === attempt.current) setMessage((error as Error).message);
    } finally { if (currentAttempt === attempt.current) setBusy(false); }
  }

  async function removeBinding() {
    if (!enrollment || busy) return;
    clearSession();
    checkout.current?.resetVerification();
    const currentAttempt = attempt.current;
    setBusy(true);
    setRemovingBinding(true);
    setBindingMessage("Requesting removal of this Visa device binding…");
    try {
      const result = await removeEuropeDeviceBinding(enrollment.tokenId, deviceId);
      if (currentAttempt !== attempt.current) return;
      if (result === "APPROVED") {
        setVerificationMode("new-binding");
        setMessage("Visa device binding removed. Prepare browser verification for a new binding attempt. Visa selects whether 3DS is required.");
        setBindingMessage("APPROVED — Visa removed the device binding. The passkey remains in your device's password manager.");
        goToStep(3);
      } else {
        setBindingMessage(result === "CHALLENGE"
          ? "CHALLENGE — Visa requires cardholder verification before removal. The binding was not confirmed removed."
          : "REJECTED — Visa declined removal. The binding was not confirmed removed.");
      }
      log(`Visa device removal returned ${result}.`);
    } catch (error) {
      if (currentAttempt === attempt.current) setBindingMessage((error as Error).message);
    } finally {
      if (currentAttempt === attempt.current) { setBusy(false); setRemovingBinding(false); }
    }
  }

  async function prepare() {
    if (!enrollment || !container.current) return;
    let verification: ReturnType<typeof sandboxVerificationContext>;
    try { verification = sandboxVerificationContext(verificationAmount, verificationCurrency, verificationMerchant, verificationUrl); }
    catch (error) { setMessage((error as Error).message); return; }
    clearSession();
    checkout.current?.resetVerification();
    const currentAttempt = attempt.current;
    setBusy(true);
    setMessage("Obtaining browser context and the next verification step from Visa sandbox…");
    try {
      const accessToken = await fetchAccessToken();
      const { VgsAgenticAuth } = await import("../vgs-agentic-auth.js");
      if (currentAttempt !== attempt.current || !container.current) return;
      const prepared = await prepareSandboxCard(enrollment, consumerEmail.trim(), config, window.location.origin,
        container.current, accessToken, (options) => new VgsAgenticAuth(options), () => currentContext.current, verification, verificationMode === "new-binding", true);
      if (currentAttempt !== attempt.current) { prepared.destroy(); return; }
      const state = prepared.preparationState ?? "unsupported_context";
      setPhase(state);
      if (["web_challenge_pending", "registration_ready", "authentication_ready"].includes(state)) {
        session.current = prepared;
        setMessage(state === "web_challenge_pending" ? "Visa requested browser 3DS. Open issuer verification to continue."
          : state === "registration_ready" ? "Visa is ready to set up or link a passkey. Continue with Visa, or repeat the verification test."
            : "Visa returned authentication context for an existing passkey. Continue to a purchase and authenticate that purchase separately.");
        log("Visa browser preparation returned the next supported verification action.");
        if (state === "authentication_ready") {
          prepared.destroy(); session.current = null;
          setPhase("prepared");
          goToStep(4);
        }
      } else {
        prepared.destroy();
        setMessage(state === "otp_challenge_pending"
            ? "Visa requested OTP instead of browser 3DS. This test stops here; use a card and tenant enabled for 3DS Web Step-Up."
            : "Visa returned an unsupported verification context. This test cannot continue to 3DS.");
      }
    } catch {
      if (currentAttempt === attempt.current) {
        setPhase("error");
        setMessage("Preparation failed. Check the sandbox API, Visa browser setup, and callback configuration, then prepare again.");
      }
    } finally { if (currentAttempt === attempt.current) setBusy(false); }
  }

  async function verify() {
    if (!session.current) return;
    const currentAttempt = attempt.current;
    const registering = phase === "registration_ready";
    setBusy(true);
    setMessage(registering
      ? "In the Visa panel below, choose Continue to open your device's passkey prompt. You can cancel this attempt to repeat the 3DS test."
      : "Complete 3DS verification in the issuer window.");
    try {
      const result = await continueEuropeSession(session.current);
      if (currentAttempt !== attempt.current) return;
      setPhase(result.phase);
      if (result.phase === "registration_ready") {
        setMessage("3DS approved. Set up or link a passkey to continue the full journey, or repeat the verification test.");
        log("Issuer verification completed. Passkey registration remains separate.");
      } else {
        session.current.destroy(); session.current = null;
        setMessage("Visa completed passkey setup or linking. Continue to create a purchase request, then authenticate that purchase separately.");
        log("Visa reported passkey setup or linking complete. Purchase authentication remains separate.");
        goToStep(4);
      }
    } catch (error) {
      if (currentAttempt !== attempt.current) return;
      session.current?.destroy(); session.current = null;
      setPhase("error");
      const code = (error as { code?: string }).code;
      setMessage(code === "popup_blocked" ? "Allow popups for this site, then prepare again."
        : code === "verification_declined" ? "The issuer declined verification. Prepare again to start a new attempt."
          : registering ? "Passkey registration stopped or could not complete. Check the Visa panel and your device's passkey prompt, then prepare again."
            : "3DS verification stopped or could not complete. Check the issuer window and approved callback, then prepare again.");
    } finally {
      if (currentAttempt === attempt.current) {
        setBusy(false);
      }
    }
  }

  return <section aria-label="Visa v2 Europe sandbox journey">
    <p className="text-sm mb-3">Visa sandbox · Card → Token → 3DS / Passkey → Purchase → PAYMENT authentication → Credential</p>
    <p className="text-sm text-gray-500 mb-3">Use a Visa test card enabled for 3DS Web Step-Up in your sandbox tenant.
      Allow popups. Visa selects the verification method.</p>
    <p className="text-xs text-gray-500 mb-4 break-all">Verification callback: {callbackUrl || "Unavailable"}.
      The callback URL must be approved for your Visa integration.</p>
    {setupError ? <p role="alert">{setupError}</p> : <>
      <EuropeStep number={1} title="Create Card (VGS Collect)" navigation={navigation} enabled={!busy}
        done={!!cardId} loading={busy && activeStep === 1} response={cardResponse}>
        <CollectCardForm visaOnly loading={busy} onLoading={setBusy} log={log}
          onResponse={(result) => setCardResponse(result && typeof result === "object" && "error" in result
            ? { error: "Card creation failed. Check your Visa test card and retry." } : { status: "Card capture returned." })}
          onCreated={({ cardId: created }) => {
            clearSession(); setCardId(created); setEnrollment(null); setDeviceId(""); setBindingMessage(""); setCardResponse({ cardId: created, network: "visa" });
            setMessage("Card saved in the sandbox vault. Enroll it for Visa v2."); goToStep(2);
          }} />
      </EuropeStep>
      <EuropeStep number={2} title="Enroll Agentic Token" navigation={navigation} enabled={!!cardId && !busy}
        done={!!enrollment} loading={busy && activeStep === 2} response={enrollment}>
        <Field label="Card ID"><input className="input" aria-label="Card ID" value={cardId} readOnly /></Field>
        <Field label="Consumer Email"><input className="input" type="email" aria-label="Consumer Email" value={consumerEmail} disabled={busy || !!enrollment}
          onChange={(event) => setConsumerEmail(event.target.value)} /></Field>
        <Button onClick={enroll} disabled={busy || !!enrollment || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(consumerEmail.trim())}>Enroll</Button>
      </EuropeStep>
      <EuropeStep number={3} title="Device Binding / Cardholder Verification (3DS)" navigation={navigation}
        enabled={!!enrollment && !busy} done={["prepared", "awaiting_payment", "authentication_ready"].includes(phase)} loading={busy && activeStep === 3}
        response={phase !== "idle" ? { state: phase } : undefined}>
        <p className="text-sm text-gray-500">Visa requires amount, currency, and merchant identity for the initial verification request. This does not create a purchase. Visa receives the amount with fractional digits truncated.</p>
        <Field label="Verification path"><select className="input" aria-label="Verification path" value={verificationMode} disabled={busy}
          onChange={(event) => { clearSession(); setVerificationMode(event.target.value); setMessage("Verification path changed. Prepare a fresh browser session."); }}>
          <option value="stored-passkey">Use stored passkey (normal flow)</option>
          <option value="new-binding">Start new device binding (request 3DS again)</option>
        </select></Field>
        <p className="text-sm text-gray-500">New device binding starts a fresh attempt. Visa can request 3DS, approve without a challenge, or decline.</p>
        <Field label="Token ID"><input className="input" aria-label="Token ID" value={enrollment?.tokenId ?? ""} readOnly /></Field>
        <Row>
          <Field label="Authentication Amount"><input className="input" aria-label="Verification amount" inputMode="decimal" value={verificationAmount} disabled={busy} onChange={(event) => { clearSession(); setVerificationAmount(event.target.value); }} /></Field>
          <CurrencyField numeric europe ariaLabel="Verification currency" value={verificationCurrency} disabled={busy} onChange={(value) => { clearSession(); setVerificationCurrency(value); }} />
        </Row>
        <Field label="Merchant Name"><input className="input" aria-label="Verification merchant name" value={verificationMerchant} disabled={busy} onChange={(event) => { clearSession(); setVerificationMerchant(event.target.value); }} /></Field>
        <Field label="Merchant URL"><input className="input" type="url" aria-label="Verification merchant URL" value={verificationUrl} disabled={busy} onChange={(event) => { clearSession(); setVerificationUrl(event.target.value); }} /></Field>
        <div className="flex flex-wrap gap-2">
          {!busy && !preparationComplete && <Button onClick={prepare} disabled={!enrollment}>Prepare browser verification</Button>}
          {!busy && ["web_challenge_pending", "registration_ready"].includes(phase) && <Button onClick={verify}>
            {phase === "web_challenge_pending" ? "Open 3DS verification" : "Set up or link passkey"}</Button>}
          {!busy && preparationComplete && <Button variant="secondary" onClick={prepare}>
            {verificationMode === "new-binding" ? "Repeat 3DS test" : "Restart verification"}
          </Button>}
          {busy && !removingBinding && <Button variant="secondary" onClick={() => { clearSession(); setMessage("Verification cancelled. Prepare again to start a new attempt."); }}>Cancel verification</Button>}
        </div>
        <p role="status" className="text-sm mt-3">{message}</p>
        {busy && phase === "web_challenge_pending" && window.location.hostname === "localhost" && <div className="mt-3">
          <p className="text-xs text-gray-500">If the approved callback opens an error page, copy its complete URL from the 3DS window address bar and paste it here. This local sandbox recovery is available only for the active attempt.</p>
          <Field label="Approved callback URL"><input className="input" type="url" aria-label="Approved callback URL"
            autoComplete="off" spellCheck={false} value={manualCallbackUrl} onChange={(event) => setManualCallbackUrl(event.target.value)} /></Field>
          <Button variant="secondary" disabled={!manualCallbackUrl.trim()} onClick={() => {
            try {
              session.current?.submitSandboxCallbackUrl?.(manualCallbackUrl.trim());
              setManualCallbackUrl("");
            } catch (error) { setMessage((error as Error).message); }
          }}>Continue from approved callback</Button>
        </div>}
        <div ref={container} className="mt-3" />
        <details className="border-t border-gray-200 mt-4 pt-3" aria-label="Reset Visa device binding">
          <summary className="text-sm cursor-pointer">Advanced: remove Visa device binding</summary>
          <p className="text-sm text-gray-500">Optional Visa removal request. Removal is not required to start another binding attempt, and the sandbox may reject it. This does not delete a passkey from your device's password manager.</p>
          <Field label="Device ID to remove"><input className="input" aria-label="Device ID to remove" value={deviceId} disabled={busy}
            maxLength={24} autoComplete="off" onChange={(event) => { setDeviceId(event.target.value); setBindingMessage(""); }} /></Field>
          <p className="text-xs text-gray-500">Prefilled from enrollment when available. Use the client device ID associated with this token's binding.</p>
          <Button variant="secondary" onClick={removeBinding} disabled={busy || !enrollment || !/^[A-Za-z0-9_-]{1,24}$/.test(deviceId.trim())}>
            {removingBinding ? "Removing Visa device binding…" : "Remove Visa device binding"}
          </Button>
          {bindingMessage && <p role="status" className="text-sm mt-2">{bindingMessage}</p>}
        </details>
      </EuropeStep>
      {enrollment && <EuropeSandboxCheckout ref={checkout} key={`${cardId}:${enrollment.tokenId}`} config={config} cardId={cardId}
        enrollment={enrollment} consumerEmail={consumerEmail.trim()} navigation={navigation} busy={busy} setBusy={setBusy} />}
    </>}
    {activeStep < 3 && <p role="status" className="text-sm my-4">{message}</p>}
    <Log entries={logs} />
  </section>;
}
