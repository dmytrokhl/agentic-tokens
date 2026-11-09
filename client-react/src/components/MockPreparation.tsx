import { activateMockScenario, fixtureScenarios } from "../sample-journeys";
import { ManualMockCheckout } from "./ManualMockCheckout";
import { useEffect, useRef, useState } from "react";
import { apiResponse, fetchAccessToken, type AppConfig } from "../api";
import { prepareMockCard, preparationMessage, visaProvisioningStatus, type MockCard, type PreparationSession } from "../preparation";
import { EUROPE_STEPS } from "../europe-journey";
import { EuropeStep } from "./EuropeStep";
import { Log } from "./Log";
import { Button, Field, Row } from "./ui";

export function MockPreparation({ config }: { config: AppConfig }) {
  const [activeStep, goToStep] = useState(1);
  const [logs, setLogs] = useState<string[]>([]);
  const [responses, setResponses] = useState<Record<number, unknown>>({});
  const log = (message: string) => setLogs((current) => [...current, message]);
  const navigation = { activeStep, goToStep, log };
  const [cards, setCards] = useState<MockCard[]>([]);
  const [cardId, setCardId] = useState("");
  const [profile, setProfile] = useState(config.mockScenario?.scenario.startsWith("eu-") ? config.mockScenario.scenario : "eu-web");
  const profiles = fixtureScenarios(config, "visa", true);
  const scenario = profiles.some((fixture) => fixture.scenario === profile) ? profile : profiles[0]?.scenario ?? "";
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("Create a synthetic card or select a saved card.");
  const [phase, setPhase] = useState<string>();
  const contextRef = useRef("");
  const sessionRef = useRef<PreparationSession | null>(null);
  const attemptRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = cards.find((card) => card.cardId === cardId);
  contextRef.current = cardId + ':' + (selected?.enrollment?.data.id ?? '');

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/mock/cards", { signal: controller.signal }),
      fetch("/api/mock/scenario", { signal: controller.signal }),
    ]).then(async ([response, scenarioResponse]) => {
      if (!response.ok || !scenarioResponse.ok) throw new Error("Unavailable");
      const result = await response.json() as { cards: MockCard[] };
      const active = await scenarioResponse.json() as { scenario?: string };
      if (!controller.signal.aborted) {
        const activeProfile = active.scenario?.startsWith("eu-") ? active.scenario : "eu-web";
        const europeCards = result.cards.filter((card) => card.brand?.toUpperCase() === "VISA" && card.scenario?.startsWith("eu-"));
        setCards(europeCards);
        setProfile(activeProfile);
        setCardId("");
      }
    }).catch(() => {
      if (!controller.signal.aborted) setMessage("Could not load local fixture cards. Check the mock server.");
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => {
      controller.abort();
      attemptRef.current += 1;
      sessionRef.current?.destroy();
    };
  }, []);

  function clearContext() {
    attemptRef.current += 1;
    sessionRef.current?.destroy();
    sessionRef.current = null;
    setPhase(undefined);
  }

  async function createCard() {
    clearContext();
    const attempt = attemptRef.current;
    setBusy(true);
    try {
      const result = await apiResponse<{ card: MockCard }>("POST", "/mock/cards", { network: "visa", scenario });
      if (attempt !== attemptRef.current) return;
      if (!result.ok || !result.body.card?.cardId) throw new Error("Unavailable");
      const card = result.body.card;
      setCards((current) => [...current.filter((item) => item.cardId !== card.cardId), card]);
      setCardId(card.cardId);
      setResponses({ 1: { cardId: card.cardId, brand: card.brand, lastFour: card.lastFour, simulated: true } });
      log("POST /mock/cards returned a synthetic Visa card."); goToStep(2);
      setMessage("Synthetic card created. Enrollment calls the actual local Maranui API.");
    } catch { if (attempt === attemptRef.current) setMessage("Synthetic card creation failed. Check the local simulator."); }
    finally { if (attempt === attemptRef.current) setBusy(false); }
  }

  async function enrollCard() {
    if (!selected || selected.enrollment) return;
    clearContext();
    const attempt = attemptRef.current;
    setBusy(true);
    try {
      await activateMockScenario(config, selected.scenario || scenario);
      if (attempt !== attemptRef.current) return;
      const result = await apiResponse<NonNullable<MockCard["enrollment"]>>(
        "POST", `/cards/${encodeURIComponent(selected.cardId)}/agentic-tokens`,
        { data: { type: "agentic_tokens", attributes: { consumer_email: "buyer@example.test", visa_flow: "v2" } } },
      );
      if (attempt !== attemptRef.current) return;
      if (!result.ok || !result.body.data?.id) throw new Error("Unavailable");
      setCards((current) => current.map((card) => card.cardId === selected.cardId ? { ...card, enrollment: result.body } : card));
      setResponses((current) => ({ ...current, 2: { tokenId: result.body.data.id, visaFlow: "v2",
        cardholderVerification: result.body.data.attributes?.cardholder_verification ?? null,
        provisioningStatus: visaProvisioningStatus(result.body.data.attributes?.provision) } }));
      log("POST /cards/{cardId}/agentic-tokens returned v2 enrollment. Verification remains separate."); goToStep(3);
      setMessage("Token provisioning returned. Provider state is retained; user verification is still separate.");
    } catch { if (attempt === attemptRef.current) setMessage("Token enrollment failed. No payment or user verification ran."); }
    finally { if (attempt === attemptRef.current) setBusy(false); }
  }

  async function prepareCard() {
    if (!selected?.enrollment || !containerRef.current) return;
    clearContext();
    const attempt = attemptRef.current;
    setBusy(true);
    setMessage("Obtaining fresh browser and Visa context from the local simulators…");
    try {
      await activateMockScenario(config, selected.scenario || scenario);
      if (attempt !== attemptRef.current) return;
      const accessToken = await fetchAccessToken();
      const { VgsAgenticAuth } = await import("../vgs-agentic-auth.js");
      if (attempt !== attemptRef.current || !containerRef.current) return;
      const session = await prepareMockCard(selected, config, containerRef.current, accessToken, (options) => new VgsAgenticAuth(options), () => contextRef.current);
      if (attempt !== attemptRef.current) { session.destroy(); return; }
      sessionRef.current = session;
      setPhase(session.preparationState);
      setResponses((current) => ({ ...current, 3: { state: session.preparationState ?? "unsupported_context", purchase: false } }));
      log("No-purchase browser session prepared; stopped before the provider-requested ceremony.");
      setMessage(preparationMessage(session.preparationState));
    } catch {
      if (attempt === attemptRef.current) setMessage("Preparation failed. No challenge, passkey ceremony, or payment completed.");
    } finally { if (attempt === attemptRef.current) setBusy(false); }
  }

  async function continueVerification() {
    const session = sessionRef.current;
    if (!session?.authenticate) return;
    const attempt = attemptRef.current;
    setBusy(true);
    setMessage('Waiting for your action in the simulated verification window…');
    try {
      const result = await session.authenticate();
      if (attempt !== attemptRef.current) return;
      if (Array.isArray(result)) {
        setResponses((current) => ({ ...current, 3: { state: "complete", evidence: "[not displayed]", purchase: false } }));
        log("No-purchase verification completed. No credential was requested; evidence is not displayed.");
        setPhase('complete');
        setMessage('Simulated PAYMENT evidence received. No credential or payment has been requested.');
      } else if (result && typeof result === 'object' && 'status' in result &&
        (result.status === 'registration_ready' || result.status === 'awaiting_payment')) {
        setPhase(result.status);
        setResponses((current) => ({ ...current, 3: { state: result.status, purchase: false } }));
        log(`Verification returned ${result.status}; the next ceremony requires a separate action.`);
        setMessage(result.status === 'registration_ready'
          ? 'Issuer verification completed. Continue to simulate passkey registration.'
          : 'Registration completed. Continue separately to simulate payment authentication.');
      } else throw new Error('Unsupported verification result');
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      const code = (error as { code?: string }).code;
      setBusy(false);
      clearContext();
      setMessage(`Verification stopped (${code ?? 'verification_failed'}). Prepare again to start a new attempt.`);
    } finally { if (attempt === attemptRef.current) setBusy(false); }
  }

  const attributes = selected?.enrollment?.data.attributes;
  const panel = (number: number) => ({ number, title: EUROPE_STEPS[number - 1], navigation,
    loading: busy && activeStep === number, response: responses[number] });
  return <section aria-label="Visa v2 Europe journey">
    <details className="mb-4 bg-white border border-gray-300 rounded-lg">
      <summary className="px-4 py-3 cursor-pointer font-semibold text-sm text-gray-500">Local test configuration</summary>
      <div className="px-4 pb-4">
        <p className="text-sm text-gray-500">Local simulation only. Synthetic cards and responses do not establish provider approval or a real payment. Profiles configure the shared simulator.</p>
        <Field label="Europe provider profile"><select className="input" value={scenario} disabled={busy} onChange={(event) => {
          clearContext(); setProfile(event.target.value); setCardId(""); setResponses({}); goToStep(1);
        }}>{profiles.map((fixture) => <option key={fixture.scenario} value={fixture.scenario}>{fixture.scenario}</option>)}</select></Field>
      </div>
    </details>
    <EuropeStep {...panel(1)} done={!!selected}>
      <p className="text-sm text-gray-500">This local runtime replaces card capture with a synthetic CMP fixture. No card details are collected.</p>
      <Button onClick={createCard} disabled={busy || !scenario}>Create synthetic Visa card</Button>
      <Field label="Saved synthetic card"><select className="input" value={cardId} disabled={busy} onChange={(event) => {
        clearContext(); setCardId(event.target.value); setResponses({}); goToStep(event.target.value ? 2 : 1);
        log("Selected card changed. Fresh browser context is required.");
        setMessage("Selected card changed. Prepare again only if testing the optional no-purchase branch.");
      }}><option value="">Select a fixture card</option>
        {cards.filter((card) => card.scenario === scenario).map((card) => <option key={card.cardId} value={card.cardId}>Visa …{card.lastFour} · {card.cardId}</option>)}
      </select></Field>
    </EuropeStep>
    <EuropeStep {...panel(2)} enabled={!!selected} done={!!selected?.enrollment}>
      <Row><Field label="Card ID"><input className="input" value={selected?.cardId ?? ""} readOnly /></Field>
        <Field label="Token ID"><input className="input" value={selected?.enrollment?.data.id ?? ""} readOnly /></Field></Row>
      <Field label="Consumer email (synthetic fixture identity)"><input className="input" value="buyer@example.test" readOnly /></Field>
      <p className="text-sm text-gray-500">Enrollment explicitly requests Visa v2. Cardholder verification is determined by the API response.</p>
      {selected?.enrollment ? <>
        <p className="text-sm">Saved enrollment reused. Verification: {attributes?.cardholder_verification ?? "not reported"}; provisioning: {visaProvisioningStatus(attributes?.provision) ?? "not reported"}.</p>
        <Button onClick={() => goToStep(3)} disabled={busy}>Continue</Button>
      </> : <Button onClick={enrollCard} disabled={busy || !selected}>Enroll Agentic Token</Button>}
    </EuropeStep>
    <EuropeStep {...panel(3)} enabled={!!selected?.enrollment} done={phase === "complete"}>
      <p className="text-sm text-gray-500">Optional: test preparation with explicit synthetic verification context. No purchase is created. This does not satisfy verification for a later purchase.</p>
      <Button onClick={() => { clearContext(); goToStep(4); }} disabled={busy}>Continue to purchase request</Button>
      <Row><Button onClick={prepareCard} disabled={busy || !selected?.enrollment}>Prepare without a purchase</Button>
        {["web_challenge_pending", "registration_ready", "authentication_ready", "awaiting_payment"].includes(phase ?? "") &&
          <Button onClick={continueVerification} disabled={busy}>
            {phase === "web_challenge_pending" ? "Continue to bank verification" : phase === "registration_ready" ? "Continue to passkey registration" : "Continue to PAYMENT authentication"}
          </Button>}</Row>
      <p role="status" className="text-sm">{message}</p>
      <div ref={containerRef} />
    </EuropeStep>
    <ManualMockCheckout key={selected?.cardId + ":" + (selected?.enrollment?.data.id ?? "")} config={config} card={selected} navigation={navigation} />
    <Log entries={logs} />
  </section>;
}
