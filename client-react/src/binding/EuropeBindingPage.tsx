import { useEffect, useRef, useState } from "react";
import { fetchAccessToken, fetchConfig } from "../api";
import { sandboxVerificationContext } from "../europe-sandbox";
import { Button } from "../components/ui";
import type { PreparationSession } from "../preparation";

export function EuropeBindingPage() {
  const params = new URLSearchParams(window.location.search);
  const container = useRef<HTMLDivElement>(null);
  const session = useRef<PreparationSession | null>(null);
  const attempt = useRef(0);
  const [phase, setPhase] = useState('idle');
  const [busy, setBusy] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const [message, setMessage] = useState('Prepare the selected card, then continue each required verification step.');
  const sessionId = params.get('sessionId');
  const cardId = params.get('cardId');
  const tokenId = params.get('tokenId');
  const buyerId = params.get('buyer_id');
  const amount = params.get('amount');
  const currency = params.get('currency');

  useEffect(() => () => { attempt.current += 1; session.current?.destroy(); }, []);

  function stop() {
    attempt.current += 1;
    session.current?.destroy();
    session.current = null;
    setBusy(false);
    setPhase('idle');
  }

  async function prepare() {
    stop();
    const currentAttempt = attempt.current;
    setBusy(true);
    try {
      const consumerEmail = params.get('consumer_email');
      const currencyCode = params.get('currency_code');
      if (!sessionId || !cardId || !tokenId || !buyerId || !amount || !currency || !currencyCode || !consumerEmail) {
        throw new Error('The payment request is incomplete. Return to the agent to obtain a valid request.');
      }
      const verification = sandboxVerificationContext(amount, currencyCode, params.get("merchant_name") ?? "", params.get("merchant_url") ?? "");
      const config = await fetchConfig();
      const mock = config.mockMode === 'vic-v2-europe';
      setSimulated(mock);
      const callbackUrl = mock ? config.mockSdk?.callbackOrigin + '/' : config.visaEuCallbackUrl;
      if (!callbackUrl || (mock && !config.mockSdk)) throw new Error('The verification callback is not configured.');
      const accessToken = await fetchAccessToken();
      const { VgsAgenticAuth } = await import('../vgs-agentic-auth.js');
      if (currentAttempt !== attempt.current || !container.current) return;
      const flow = new VgsAgenticAuth({
        tokenId, consumerEmail, accessToken, clientRefId: crypto.randomUUID(),
        environment: mock ? 'local' : params.get('environment') ?? 'sandbox',
        preparationMode: 'vic-v2-europe', callbackUrl,
        checkoutContext: window.location.href, getCheckoutContext: () => window.location.href,
        authenticationAmount: verification.amount, currencyCode: verification.currencyCode, merchantName: verification.merchantName, merchantUrl: verification.merchantUrl,
        ...(mock ? { mockApiBase: config.mockSdk!.apiOrigin, mockVppOrigin: config.mockSdk!.vppOrigin } : {}),
      });
      const prepared = await flow.startSession(container.current);
      if (currentAttempt !== attempt.current) { prepared.destroy(); return; }
      session.current = prepared;
      setPhase(prepared.preparationState ?? 'unsupported_context');
      setMessage('Preparation completed. Continue the required verification step.');
    } catch (error) {
      if (currentAttempt === attempt.current) { setPhase('error'); setMessage((error as Error).message); }
    } finally { if (currentAttempt === attempt.current) setBusy(false); }
  }

  async function verify() {
    if (!session.current?.authenticate) return;
    const currentAttempt = attempt.current;
    setBusy(true);
    try {
      const result = await session.current.authenticate();
      if (currentAttempt !== attempt.current) return;
      if (!Array.isArray(result)) {
        if (!result || typeof result !== 'object' || !('status' in result) ||
          !['registration_ready', 'awaiting_payment'].includes(String(result.status))) throw new Error('Unsupported verification result.');
        setPhase(String(result.status));
        setMessage(result.status === 'registration_ready' ? 'Bank verification completed. Register the passkey next.'
          : 'Registration completed. Payment authentication requires a separate action.');
        return;
      }
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId!)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'PAYMENT', assuranceData: result, cardId, tokenId, buyerId }),
      });
      if (!response.ok) throw new Error('The agent did not accept the authentication result. Return to the agent before trying again.');
      session.current.destroy();
      session.current = null;
      setPhase('done');
      setMessage(`${simulated ? 'Simulated payment' : 'Payment'} authentication completed. Return to the agent to continue. No payment outcome is implied.`);
    } catch (error) {
      if (currentAttempt !== attempt.current) return;
      session.current?.destroy();
      session.current = null;
      setPhase('error');
      setMessage((error as Error).message);
    } finally { if (currentAttempt === attempt.current) setBusy(false); }
  }

  const canContinue = ['web_challenge_pending', 'registration_ready', 'authentication_ready', 'awaiting_payment'].includes(phase);
  return <main className="max-w-xl mx-auto p-6 min-h-screen bg-gray-50">
    <h1 className="text-xl font-semibold">Authenticate the payment request</h1>
    {simulated && <p className="my-3 p-3 border border-amber-300 bg-amber-50">Local simulation. No real bank, passkey, or payment operation occurs.</p>}
    <p className="my-3">{params.get('product_name') ?? 'Purchase'} · {amount ?? 'Missing amount'} {currency}</p>
    <p role="status" className="my-3">{message}</p>
    {phase !== 'done' && <Button onClick={prepare} disabled={busy}>Prepare fresh browser context</Button>}
    {canContinue && <Button onClick={verify} disabled={busy}>
      {phase === 'web_challenge_pending' ? 'Continue bank verification' : phase === 'registration_ready' ? 'Register passkey' : 'Authenticate payment'}
    </Button>}
    {busy && <Button onClick={() => { stop(); setMessage('Verification cancelled. Prepare again to start a new attempt.'); }}>Cancel verification</Button>}
    <div ref={container} className="mt-4" />
  </main>;
}
