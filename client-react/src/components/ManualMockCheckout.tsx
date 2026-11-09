import { CurrencyField } from "./CurrencyField";
import { activateMockScenario } from "../sample-journeys";
import { useEffect, useRef, useState } from "react";
import { apiResponse, type AppConfig } from "../api";
import { EUROPE_STEPS, credentialStepComplete, purchaseStage, safeCheckoutOutcome } from "../europe-journey";
import type { MockCard } from "../preparation";
import { EuropeStep, type EuropeNavigation } from "./EuropeStep";
import { Button, Field, Row } from "./ui";

interface CheckoutResult extends Record<string, unknown> {
  status?: string; intentId?: string | null; instructionStatus?: string | null;
  binding?: { sessionId: string; url: string }; nextStep?: string; error?: string;
}

export function ManualMockCheckout({ config, card, navigation }: { config: AppConfig; card?: MockCard; navigation: EuropeNavigation }) {
  const [amount, setAmount] = useState("5.33");
  const [currency, setCurrency] = useState("EUR");
  const [outcome, setOutcome] = useState("APPROVED");
  const [requestScope, setRequestScope] = useState<{ amount: number; currency: string } | null>(null);
  const [requestId, setRequestId] = useState("");
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [responses, setResponses] = useState<Record<number, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Create a purchase request, then obtain fresh verification for that purchase.");
  const bindingRef = useRef<CheckoutResult["binding"]>(undefined);
  const generationRef = useRef(0);
  useEffect(() => () => { generationRef.current += 1; }, []);
  if (config.mockMode !== "vic-v2-europe") return null;
  const buyerId = card ? `manual-${card.cardId}` : "";
  const waiting = result?.status === "waiting_for_authentication";
  const awaitingOutcome = result?.status === "awaiting_payment_outcome";
  const active = result?.instructionStatus === "ACTIVE";
  const uncertain = ["outcome_unknown", "state_recovery_required"].includes(result?.status ?? "");

  async function createRequest(generation: number) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Enter a positive purchase amount.");
    const id = `manual-${crypto.randomUUID()}`;
    const created = await apiResponse("POST", "/payment-requests", {
      id, buyerId, amount: value, currency, reason: "Manual simulated Visa v2 purchase",
    });
    if (generation !== generationRef.current) return;
    if (!created.ok) throw new Error("The local payment request could not be created.");
    setRequestId(id);
    setRequestScope({ amount: value, currency });
    setResponses({ 4: { paymentRequestId: id, amount: value, currency, simulated: true } });
    navigation.log("POST /payment-requests completed. No credential was requested.");
    return id;
  }

  async function run(operation: string) {
    if (!card) return;
    const generation = ++generationRef.current;
    setBusy(true);
    try {
      if (card.scenario) await activateMockScenario(config, card.scenario);
      if (generation !== generationRef.current) return;
      if (operation === "create") {
        const id = await createRequest(generation);
        if (!id) return;
        setResult(null); bindingRef.current = undefined;
        setMessage("Purchase request created. Start its verification separately."); navigation.goToStep(5);
        return;
      }
      const id = ["retrieve", "cancel"].includes(operation) ? await createRequest(generation) : requestId;
      if (!id || generation !== generationRef.current) return;
      const step = operation === "confirm" ? 7 : ["retrieve", "cancel"].includes(operation) ? 8 : waiting ? 6 : 5;
      const response = await apiResponse<CheckoutResult>("POST", "/mock/checkout", {
        operation, paymentRequestId: id, buyerId, cardId: card.cardId,
        ...(operation === "confirm" ? { simulatedOutcome: outcome } : {}),
        ...(operation === "cancel" ? { evidenceSessionId: bindingRef.current?.sessionId } : {}),
      });
      if (generation !== generationRef.current) return;
      if (!response.ok) throw new Error("The local merchant operation did not complete. Review the request before retrying.");
      if (response.body.binding) bindingRef.current = response.body.binding;
      setResult(response.body);
      setResponses((current) => ({ ...current, ...(response.body.status === "awaiting_payment_outcome" ? { 7: undefined } : {}), [step]: safeCheckoutOutcome(response.body) }));
      navigation.log(`POST /mock/checkout (${operation}) returned ${safeCheckoutOutcome(response.body).status ?? "a simulated result"}.`);
      setMessage(response.body.nextStep || "Simulated result received. No real payment or publication occurred.");
      navigation.goToStep(purchaseStage(response.body.status));
    } catch {
      if (generation === generationRef.current) {
        setMessage("The operation did not complete. No automatic retry was made; review the current request before continuing.");
        navigation.log("Merchant operation stopped. No automatic retry was made.");
      }
    } finally { if (generation === generationRef.current) setBusy(false); }
  }

  const panel = (number: number) => ({ number, title: EUROPE_STEPS[number - 1], navigation, loading: busy && navigation.activeStep === number, response: responses[number] });
  return <>
    <EuropeStep {...panel(4)} enabled={!!card?.enrollment} done={!!requestId}>
      <p className="text-sm text-gray-500">POST /payment-requests creates a merchant request. The default mandate covers one purchase. Every result is simulated.</p>
      <Row><Field label="Amount"><input className="input" value={amount} disabled={busy || (!!requestId && !result) || waiting || awaitingOutcome} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /></Field>
        <CurrencyField europe value={currency} disabled={busy || (!!requestId && !result) || waiting || awaitingOutcome} onChange={setCurrency} /></Row>
      <Button onClick={() => void run("create")} disabled={busy || !card?.enrollment || waiting || awaitingOutcome || uncertain || active}>Create purchase request</Button>
      {active && <p className="text-sm text-gray-500">Use Active Instruction below for a subsequent credential or cancellation before starting another instruction.</p>}
    </EuropeStep>
    <EuropeStep {...panel(5)} enabled={!!requestId} done={awaitingOutcome || !!result?.intentId}>
      <Field label="Payment request ID"><input className="input" value={requestId} readOnly /></Field>
      <Row><Field label="Requested amount"><input className="input" value={requestScope?.amount ?? ""} readOnly /></Field>
        <Field label="Requested currency"><input className="input" value={requestScope?.currency ?? ""} readOnly /></Field></Row>
      <p className="text-sm text-gray-500">The merchant authorization operation obtains the purchase verification page. Preparation without a purchase does not satisfy this purchase’s PAYMENT verification.</p>
      <Button onClick={() => void run("authorize")} disabled={busy || !requestId || !!result}>Start purchase verification</Button>
      {waiting && bindingRef.current && <>
        <p className="text-sm"><a className="text-blue-700 underline" href={bindingRef.current.url} target="_blank" rel="noopener noreferrer">Open this purchase’s verification page</a></p>
        <p className="text-sm text-gray-500">Complete each provider-requested issuer, registration, and PAYMENT action. Registration alone is not PAYMENT verification.</p>
        <Button onClick={() => navigation.goToStep(6)} disabled={busy}>Continue to credential request</Button>
      </>}
    </EuropeStep>
    <EuropeStep {...panel(6)} enabled={waiting || awaitingOutcome || !!result?.intentId} done={credentialStepComplete(responses[6])}>
      <p className="text-sm text-gray-500">This merchant operation reads the completed verification and requests the Visa instruction and first credential together. It does not perform a separate earlier instruction call.</p>
      <Button onClick={() => void run("authorize")} disabled={busy || !waiting}>Read completed verification and request credential</Button>
    </EuropeStep>
    <EuropeStep {...panel(7)} enabled={awaitingOutcome || !!responses[7]} done={!!responses[7]}>
      <Field label="Explicit simulated merchant outcome"><select className="input" value={outcome} onChange={(event) => setOutcome(event.target.value)} disabled={busy || !awaitingOutcome}>
        <option>APPROVED</option><option>DECLINED</option><option>CANCELLED</option>
      </select></Field>
      <p className="text-sm text-gray-500">APPROVED completes this instruction. DECLINED retains an ACTIVE instruction only when the provider reports it.</p>
      <Button onClick={() => void run("confirm")} disabled={busy || !awaitingOutcome}>Confirm selected simulated outcome</Button>
    </EuropeStep>
    <EuropeStep {...panel(8)} enabled={!!result?.intentId} done={result?.instructionStatus === "CANCELLED"}>
      <p className="text-sm text-gray-500">Optional: each action creates a fresh merchant request, then performs the selected operation on the ACTIVE instruction. Later credentials require a separate confirmation in step 7.</p>
      <Row><Button onClick={() => void run("retrieve")} disabled={busy || !active || awaitingOutcome || uncertain}>Request subsequent credential</Button>
        <Button onClick={() => void run("cancel")} disabled={busy || !active || awaitingOutcome || uncertain || !bindingRef.current} variant="secondary">Cancel active instruction</Button></Row>
    </EuropeStep>
    <p role="status" className="text-sm mb-3">{message}</p>
  </>;
}
