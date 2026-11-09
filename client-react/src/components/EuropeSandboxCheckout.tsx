import { CurrencyField } from "./CurrencyField";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { fetchAccessToken, type AppConfig } from "../api";
import { prepareSandboxCard, type EuropeEnrollment } from "../europe-sandbox";
import { continueEuropeSession, createEuropePurchase, credentialHandoff, credentialSummary, confirmationSummary, EuropeOutcomeUnknown,
  openSourceConsumer, parseAgentInputs, purchaseMandates, purchaseTransaction, requirePaymentEvidence, submitEuropeOperation,
  type PaymentEvidence, type Purchase } from "../europe-payment";
import type { PreparationSession } from "../preparation";
import { EUROPE_STEPS } from "../europe-journey";
import { EuropeStep, type EuropeNavigation } from "./EuropeStep";
import { Button, Field, Row } from "./ui";

export interface EuropeCheckoutHandle { resetVerification: () => void }

export function EuropeSandboxCheckout({ config, cardId, enrollment, consumerEmail, navigation, busy, setBusy, ref }: {
  config: AppConfig; cardId: string; enrollment: EuropeEnrollment; consumerEmail: string;
  navigation: EuropeNavigation; busy: boolean; setBusy: (value: boolean) => void;
  ref?: Ref<EuropeCheckoutHandle>;
}) {
  const [amount, setAmount] = useState("5.33");
  const [currency, setCurrency] = useState("EUR");
  const [merchantName, setMerchantName] = useState("Best Buy");
  const [merchantUrl, setMerchantUrl] = useState("https://www.bestbuy.com");
  const [quantity, setQuantity] = useState("1");
  const [expiry, setExpiry] = useState(() => new Date(Date.now() + 864000000).toISOString());
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [phase, setPhase] = useState("idle");
  const [message, setMessage] = useState("Create a purchase request, then authenticate that purchase separately.");
  const [agentInputs, setAgentInputs] = useState("");
  const [agentMode, setAgentMode] = useState("open-source");
  const [consumerUsername, setConsumerUsername] = useState(consumerEmail);
  const [consumerCountry, setConsumerCountry] = useState("DE");
  const [consumerLanguage, setConsumerLanguage] = useState("en");
  const [consumerId, setConsumerId] = useState(enrollment.consumerId);
  const [agentSlug, setAgentSlug] = useState("");
  const [intentId, setIntentId] = useState("");
  const [credential, setCredential] = useState<ReturnType<typeof credentialSummary> | null>(null);
  const [outcome, setOutcome] = useState("APPROVED");
  const [confirmation, setConfirmation] = useState<Record<string, unknown> | null>(null);
  const [confirmationResult, setConfirmationResult] = useState<ReturnType<typeof confirmationSummary> | null>(null);
  const instructionStatus = confirmationResult?.instructionStatus ?? null;
  const [unknown, setUnknown] = useState(false);
  const session = useRef<PreparationSession | null>(null);
  const evidence = useRef<PaymentEvidence | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const context = JSON.stringify([cardId, enrollment.tokenId, consumerEmail, purchase]);
  const currentContext = useRef(context);
  useEffect(() => { currentContext.current = context; }, [context]);
  useEffect(() => () => { generation.current += 1; session.current?.destroy(); evidence.current = null; }, []);

  function clearVerification() {
    generation.current += 1;
    session.current?.destroy(); session.current = null; evidence.current = null;
    setPhase("idle"); setBusy(false);
  }

  useImperativeHandle(ref, () => ({ resetVerification() {
    clearVerification();
    setAgentInputs("");
    setMessage(purchase
      ? "Previous verification cleared. Prepare fresh purchase verification before requesting a credential."
      : "Create a purchase request, then authenticate that purchase separately.");
  } }));

  function createPurchase() {
    try {
      const request = createEuropePurchase(amount, currency, merchantName, merchantUrl, quantity, expiry);
      clearVerification(); setPurchase(request); setAgentInputs("");
      setMessage("Purchase request created. Visa creates its instruction together with the first credential in step 6.");
      navigation.log("Purchase request recorded in this browser session. No Visa instruction or credential requested.");
      navigation.goToStep(5);
    } catch (error) { setMessage((error as Error).message); }
  }

  async function preparePurchase() {
    if (!purchase || !container.current) return;
    clearVerification();
    const attempt = generation.current;
    setBusy(true);
    setMessage("Preparing fresh verification for this purchase…");
    try {
      const accessToken = await fetchAccessToken();
      const { VgsAgenticAuth } = await import("../vgs-agentic-auth.js");
      if (attempt !== generation.current || !container.current) return;
      const prepared = await prepareSandboxCard(enrollment, consumerEmail, config, window.location.origin,
        container.current, accessToken, (options) => new VgsAgenticAuth(options), () => currentContext.current,
        { amount: purchase.amount, currencyCode: purchase.currencyCode, merchantName: purchase.merchantName, merchantUrl: purchase.merchantUrl });
      if (attempt !== generation.current) { prepared.destroy(); return; }
      const next = prepared.preparationState ?? "unsupported_context";
      setPhase(next);
      if (["web_challenge_pending", "registration_ready", "authentication_ready"].includes(next)) {
        session.current = prepared;
        setMessage("Continue the verification action Visa requested. Each ceremony requires a separate click.");
      } else {
        prepared.destroy();
        setMessage(next === "otp_challenge_pending" ? "Visa requested OTP. This browser journey requires a supported Web Step-Up or passkey context."
          : "Visa returned an unsupported purchase verification context.");
      }
    } catch {
      if (attempt === generation.current) setMessage("Purchase preparation failed. Check the sandbox API and Visa browser configuration.");
    } finally { if (attempt === generation.current) setBusy(false); }
  }

  async function verifyPurchase() {
    if (!session.current) return;
    const attempt = generation.current;
    setBusy(true);
    try {
      const result = await continueEuropeSession(session.current);
      if (attempt !== generation.current) return;
      setPhase(result.phase);
      if (result.evidence) {
        evidence.current = result.evidence;
        session.current.destroy(); session.current = null;
        setMessage("Fresh PAYMENT evidence received for this purchase. Request the payment credential next.");
        navigation.log("Purchase PAYMENT authentication completed. Evidence remains in memory and is not displayed.");
        navigation.goToStep(6);
      } else setMessage(result.phase === "registration_ready" ? "Issuer verification completed. Register the passkey next."
        : "Passkey registration completed. Authenticate this purchase in a separate PAYMENT ceremony.");
    } catch {
      if (attempt === generation.current) {
        clearVerification();
        setMessage("Purchase verification stopped. Prepare again for a fresh attempt; no credential was requested.");
      }
    } finally { if (attempt === generation.current) setBusy(false); }
  }

  async function requestCredential() {
    if (!purchase || !evidence.current || intentId || unknown) return;
    const attempt = generation.current;
    setBusy(true);
    try {
      const agent = agentMode === "open-source" ? { agent: "open-source", consumer: openSourceConsumer(consumerEmail, consumerUsername, consumerCountry, consumerLanguage) } : parseAgentInputs(agentInputs, "credential", consumerId);
      const result = await submitEuropeOperation("credential", cardId, enrollment.tokenId, {
        ...agent, ...(consumerId ? { consumer_id: consumerId } : {}), purchase_type: "PURCHASE_HITL",
        assurance_data: requirePaymentEvidence(evidence.current), mandates: purchaseMandates(purchase), transaction: purchaseTransaction(purchase),
      });
      if (attempt !== generation.current) return;
      const summary = credentialSummary(result);
      if (typeof summary.intentId !== "string" || !summary.intentId) throw new EuropeOutcomeUnknown("The provider returned no instruction identifier. Reconcile before another request.");
      setIntentId(summary.intentId); setCredential(summary); setAgentInputs(""); evidence.current = null;
      setAgentSlug(String(agent.agent));
      if (typeof summary.consumerId === "string") setConsumerId(summary.consumerId);
      navigation.log(summary.usable ? "Visa created an instruction and issued the first payment credential." : "Visa returned an instruction without a usable credential.");
      setMessage(summary.usable ? "Payment credential issued. This demo does not charge the card. Report the merchant outcome separately."
        : "Keep the instruction ID. No usable payment credential was returned; confirmation remains disabled.");
      if (summary.usable) navigation.goToStep(7);
    } catch (error) {
      if (attempt === generation.current) { setUnknown(error instanceof EuropeOutcomeUnknown); setMessage((error as Error).message); }
    } finally { if (attempt === generation.current) setBusy(false); }
  }

  function prepareConfirmation() {
    if (!purchase) return;
    const completed = outcome === "APPROVED";
    setConfirmation({ instruction_completed: completed, confirmation_data: [{
      mandate_id: purchase.mandateId, mandate_status: completed ? "COMPLETED" : "ACTIVE",
      transaction_reference_id: purchase.referenceId, transaction_status: outcome,
      transaction_timestamp: String(Math.floor(Date.now() / 1000)), transaction_amount: purchaseTransaction(purchase).transaction_amount,
    }] });
    setAgentInputs("");
    setMessage(agentSlug === "open-source" ? "Review the outcome report, then send confirmation. No agent signature is needed."
      : "Supply a fresh confirmation signature for the displayed outcome report.");
  }

  async function confirm() {
    if (!confirmation || !intentId || !credential?.usable || confirmationResult || unknown || busy) return;
    const attempt = generation.current;
    setBusy(true);
    try {
      const supplied = agentSlug === "open-source" ? { agent: "open-source" } : parseAgentInputs(agentInputs, "confirmation");
      if (supplied.agent !== agentSlug) throw new Error("Use the same enabled agent as the credential request.");
      const result = await submitEuropeOperation("confirmation", cardId, enrollment.tokenId, { ...supplied, ...confirmation }, intentId);
      if (attempt !== generation.current) return;
      const accepted = confirmationSummary(result);
      setConfirmationResult(accepted); setAgentInputs("");
      setMessage(accepted.instructionStatus
        ? "The sandbox outcome report was accepted. It does not establish a charge or settlement."
        : "Confirmation accepted; instruction status unavailable. It does not establish a charge or settlement.");
      navigation.log("Visa accepted the manually reported sandbox outcome."); navigation.goToStep(8);
    } catch (error) {
      if (attempt === generation.current) { setUnknown(error instanceof EuropeOutcomeUnknown); setMessage((error as Error).message); }
    } finally { if (attempt === generation.current) setBusy(false); }
  }

  const locked = busy || !!intentId || unknown;
  const preparationComplete = ["web_challenge_pending", "registration_ready", "authentication_ready", "awaiting_payment", "complete"].includes(phase);
  const panel = (number: number) => ({ number, title: EUROPE_STEPS[number - 1], navigation, loading: busy && navigation.activeStep === number });
  const actionLabel = phase === "web_challenge_pending" ? "Open purchase 3DS verification" : phase === "registration_ready" ? "Register purchase passkey" : "Authenticate purchase";
  return <>
    <EuropeStep {...panel(4)} enabled={!busy} done={!!purchase} response={purchase}>
      <p className="text-sm text-gray-500">Create the purchase request here. Visa records the instruction with the first credential in step 6.</p>
      <Field label="Merchant Name"><input aria-label="Merchant name" className="input" value={merchantName} disabled={locked} onChange={(event) => setMerchantName(event.target.value)} /></Field>
      <Field label="Merchant URL"><input aria-label="Merchant URL" type="url" className="input" value={merchantUrl} disabled={locked} onChange={(event) => setMerchantUrl(event.target.value)} /></Field>
      <Row>
        <Field label="Amount"><input aria-label="Purchase amount" type="number" min="0.01" step="0.01" className="input" value={amount} disabled={locked} onChange={(event) => setAmount(event.target.value)} /></Field>
        <CurrencyField europe ariaLabel="Purchase currency" value={currency} disabled={locked} onChange={setCurrency} />
      </Row>
      <Row>
        <Field label="Quantity"><input aria-label="Mandate quantity" type="number" min="1" step="1" className="input" value={quantity} disabled={locked} onChange={(event) => setQuantity(event.target.value)} /></Field>
        <Field label="Effective Until"><input aria-label="Mandate expiry" className="input" value={expiry} disabled={locked} onChange={(event) => setExpiry(event.target.value)} /></Field>
      </Row>
      <Button onClick={createPurchase} disabled={locked}>Create purchase request</Button>
    </EuropeStep>
    <EuropeStep {...panel(5)} enabled={!!purchase && !busy} done={phase === "complete"} response={{ state: phase }}>
      <p className="text-sm text-gray-500">This purchase needs its own PAYMENT evidence. Earlier registration and no-purchase preparation cannot replace it.</p>
      <div className="flex flex-wrap gap-2"><Button onClick={preparePurchase} disabled={locked || preparationComplete} variant={preparationComplete ? "secondary" : "primary"}>
        {preparationComplete ? "Purchase preparation complete" : busy && phase === "idle" ? "Preparing purchase verification…" : "Prepare purchase verification"}</Button>
        {["web_challenge_pending", "registration_ready", "authentication_ready", "awaiting_payment"].includes(phase)
          && <Button onClick={verifyPurchase} disabled={busy}>{actionLabel}</Button>}
        {busy && ["web_challenge_pending", "registration_ready", "authentication_ready", "awaiting_payment"].includes(phase)
          && <Button variant="secondary" onClick={() => { clearVerification(); setMessage("Verification cancelled. Prepare again to continue."); }}>Cancel purchase verification</Button>}</div>
      {preparationComplete && <p role="status" className="text-sm mt-3 text-green-700">
        Purchase preparation complete. {phase === "complete" ? "Payment authentication complete. Continue to get your payment credential." : `Next: ${actionLabel.toLowerCase()}.`}
      </p>}
      <div ref={container} className="mt-3" />
    </EuropeStep>
    <EuropeStep {...panel(6)} enabled={phase === "complete" && !busy} done={!!credential?.usable} response={credential}>
      <Field label="Agent identity"><select aria-label="Agent identity" className="input" value={agentMode} disabled={locked}
        onChange={(event) => { setAgentMode(event.target.value); setAgentInputs(""); }}>
        <option value="open-source">Open-source — no external agent service</option>
        <option value="external">External agent — supply JSON inputs</option>
      </select></Field>
      <p className="text-sm text-gray-500">{agentMode === "open-source"
        ? "Uses Visa's open-source agent identity. No agent signature or pasted JSON is needed. The demo backend must be configured to encrypt the instruction."
        : "Use fresh values from the enabled agent for this exact scope. Keep its private keys in the agent service."}</p>
      {agentMode === "open-source" && <>
        <Field label="Consumer username"><input aria-label="Consumer username" className="input" value={consumerUsername} disabled={locked}
          onChange={(event) => setConsumerUsername(event.target.value)} /></Field>
        <Row>
          <Field label="Consumer country (two-letter code)"><input aria-label="Consumer country" className="input" value={consumerCountry} maxLength={2} placeholder="DE" disabled={locked}
            onChange={(event) => setConsumerCountry(event.target.value)} /></Field>
          <Field label="Consumer language (two-letter code)"><input aria-label="Consumer language" className="input" value={consumerLanguage} maxLength={2} disabled={locked}
            onChange={(event) => setConsumerLanguage(event.target.value)} /></Field>
        </Row>
      </>}
      {purchase && <pre className="text-xs overflow-auto max-h-72 bg-gray-100 p-3">{JSON.stringify(credentialHandoff(purchase, "credential", consumerId), null, 2)}</pre>}
      {agentMode === "external" && <Field label="Agent credential inputs (JSON)"><textarea aria-label="Agent credential inputs" className="input min-h-40" value={agentInputs} disabled={locked}
        placeholder={'{"agent":"<enabled-agent>","agent_signature":{...},"encrypted_instruction":"<agent-sealed-JWE>","consumer":{...}}'}
        onChange={(event) => setAgentInputs(event.target.value)} /></Field>}
      <Button onClick={requestCredential} disabled={locked || phase !== "complete"}>Create Visa instruction and get payment credential</Button>
    </EuropeStep>
    <EuropeStep {...panel(7)} enabled={!!credential?.usable && !busy} done={!!confirmationResult} response={confirmationResult ?? undefined}>
      <p className="text-sm text-gray-500">Manually report a sandbox outcome. This action does not call a payment processor or charge the card.</p>
      <Field label="Reported sandbox outcome"><select aria-label="Reported sandbox outcome" className="input" value={outcome} disabled={busy || !!confirmationResult || unknown}
        onChange={(event) => { setOutcome(event.target.value); setConfirmation(null); setAgentInputs(""); }}><option>APPROVED</option><option>DECLINED</option><option>CANCELLED</option></select></Field>
      <Button onClick={prepareConfirmation} disabled={busy || !!confirmationResult || unknown}>Prepare outcome report</Button>
      {confirmation && <><pre className="text-xs overflow-auto max-h-72 bg-gray-100 p-3">{JSON.stringify({ operation: "confirmation", signatureTag: "confirmation-request", intentId, ...confirmation }, null, 2)}</pre>
        {agentSlug !== "open-source" && <Field label="Agent confirmation inputs (JSON)"><textarea aria-label="Agent confirmation inputs" className="input min-h-24" value={agentInputs} disabled={busy || !!confirmationResult || unknown}
          onChange={(event) => setAgentInputs(event.target.value)} /></Field>}
        <Button onClick={confirm} disabled={busy || !!confirmationResult || unknown}>Send confirmation</Button></>}
    </EuropeStep>
    <EuropeStep {...panel(8)} enabled={!!intentId && !busy} response={{ intentId, confirmationAccepted: !!confirmationResult, instructionStatus }}>
      <p className="text-sm">Keep this instruction ID for subsequent credentials or cancellation through the existing v2 API or MCP tools.</p>
    </EuropeStep>
    {navigation.activeStep >= 4 && <p role="status" className="text-sm my-4">{message}</p>}
  </>;
}
