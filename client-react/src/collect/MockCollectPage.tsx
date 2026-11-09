import { useEffect, useState } from "react";
import { Button } from "../components/ui";
import { fetchConfig } from "../api";
import { CollectPage } from "./CollectPage";

export function CollectEntry() {
  const [mode, setMode] = useState<string>('loading');
  useEffect(() => {
    let active = true;
    fetchConfig().then((config) => { if (active) setMode(config.mockMode ?? 'provider'); })
      .catch(() => { if (active) setMode('error'); });
    return () => { active = false; };
  }, []);
  if (mode === 'loading') return <p>Loading card entry…</p>;
  if (mode === 'error') return <p>Card entry configuration is unavailable.</p>;
  return mode === 'vic-v2-europe' ? <MockCollectPage /> : <CollectPage />;
}

export function MockCollectPage() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId');
  const buyerId = params.get('buyer_id');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState('Create a synthetic fixture card to continue the local agent journey.');
  async function create() {
    if (!sessionId || !buyerId) return;
    setBusy(true);
    try {
      const response = await fetch('/api/mock/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('Synthetic card creation failed.');
      const { card } = await response.json();
      if (!card?.cardId) throw new Error('The simulator returned no card identifier.');
      const completed = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.cardId, buyerId, network: 'visa', brand: 'Visa', lastFour: card.lastFour, simulated: true }),
      });
      if (!completed.ok) throw new Error('The agent did not accept the fixture card. Return to the agent before trying again.');
      setDone(true);
      setMessage('Synthetic card submitted. Return to the agent to continue enrollment.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="max-w-xl mx-auto p-6 min-h-screen bg-gray-50">
    <h1 className="text-xl font-semibold">Add a synthetic card</h1>
    <p className="my-3 p-3 border border-amber-300 bg-amber-50">Local simulation. This fixture replaces card capture only. No card details are collected.</p>
    <p role="status" className="my-3">{message}</p>
    <Button onClick={create} disabled={busy || done || !sessionId || !buyerId}>Create synthetic Visa card for this agent request</Button>
    {(!sessionId || !buyerId) && <p>A valid agent request is required.</p>}
  </main>;
}
