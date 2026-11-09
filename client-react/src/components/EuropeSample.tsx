import { useEffect, useState } from "react";
import { fetchConfig, type AppConfig } from "../api";
import { MockPreparation } from "./MockPreparation";
import { EuropeSandbox } from "./EuropeSandbox";

export function EuropeSample() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchConfig().then((value) => { if (!cancelled) setConfig(value); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);
  return <main className="max-w-[860px] mx-auto p-6 bg-gray-50 min-h-screen text-gray-900">
    <div className="flex justify-between items-baseline">
      <h1 className="text-2xl font-bold mb-1">Agentic Tokens API — Sample App</h1>
      <button className="bg-gray-500 text-white text-xs px-3.5 py-1.5 rounded cursor-pointer hover:bg-gray-600"
        onClick={() => setRevision((value) => value + 1)}>Start Over</button>
    </div>
    <p className="text-gray-500 text-sm mb-4">Step-by-step integration reference for the VGS Agentic Tokens API</p>
    <p className="text-sm mb-4">Visa v2 Europe · <a className="text-blue-700 underline" href="?">Back to Agentic Tokens sample</a></p>
    {error ? <p role="alert">Runtime configuration is unavailable. Check the merchant server.</p>
      : !config ? <p role="status">Loading Europe configuration…</p>
      : config.mockMode === "vic-v2-europe" ? <MockPreparation key={revision} config={config} />
      : <EuropeSandbox key={revision} config={config} />}
  </main>;
}
