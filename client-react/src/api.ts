export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  statusText: string;
  body: T;
}

async function parseBody(res: Response): Promise<unknown> {
  const raw = await res.text();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function apiResponse<T = unknown>(method: string, path: string, body?: object): Promise<ApiResponse<T>> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    body: await parseBody(res) as T,
  };
}

// Keep the legacy helper intentionally loose: existing demo steps access
// endpoint-specific JSON shapes directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api(method: string, path: string, body?: object): Promise<any> {
  const res = await apiResponse(method, path, body);
  return res.body;
}

export async function fetchAccessToken(): Promise<string> {
  const res = await fetch("/api/token");
  if (!res.ok) throw new Error("Access token request failed.");
  const data = await res.json();
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("Access token unavailable.");
  return data.access_token;
}

export interface AppConfig {
  visaEuCallbackUrl?: string;
  visaEnvironment?: "local" | "dev" | "sandbox" | null;
  vaultId: string;
  vaultEnv: string;
  collectJsUrl: string;
  mockMode?: "vic-v2-europe" | null;
  mockSdk?: { apiOrigin: string; vppOrigin: string; callbackOrigin: string };
  mockScenarios?: import("./sample-journeys").MockScenario[];
  mockScenario?: import("./sample-journeys").MockScenario;
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Runtime configuration unavailable.");
  return res.json();
}

const collectJsLoaded: Partial<Record<string, Promise<void>>> = {};

export function loadCollectJs(url: string): Promise<void> {
  if (!url.trim()) return Promise.reject(new Error("Collect is unavailable in the EU local simulator; use a configured provider runtime."));
  if (collectJsLoaded[url]) return collectJsLoaded[url];
  collectJsLoaded[url] = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load Collect.js from ${url}`));
    document.head.appendChild(script);
  });
  return collectJsLoaded[url];
}
