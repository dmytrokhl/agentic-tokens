import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAccessToken, fetchConfig } from "../api";
import { Button, Field, Row } from "../components/ui";

const SANDBOX_OTP = "456789";
const CARD_DETAILS = {
  brand: "Visa",
  lastFour: "1478",
  expiry: "12/27",
};

const CURRENCY_NUMERIC_CODES: Record<string, string> = {
  USD: "840",
  EUR: "978",
  GBP: "826",
  JPY: "392",
  AUD: "036",
  CAD: "124",
};

type BindingStatus = "idle" | "starting" | "otp" | "auth" | "done" | "error";

export function BindingPage() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId") ?? "";
  const buyerId = params.get("buyer_id") ?? "";
  const tokenId = params.get("tokenId") ?? "";
  const productName = params.get("product_name") ?? "Purchase";
  const merchantName = params.get("merchant_name") ?? "VGS";
  const amount = params.get("amount") ?? "100";
  const currency = params.get("currency") ?? "USD";
  const consumerEmail = params.get("consumer_email") ?? "user@example.com";
  const environment = params.get("environment") ?? "sandbox";
  const currencyCode = params.get("currency_code") ?? CURRENCY_NUMERIC_CODES[currency] ?? "840";

  const [status, setStatus] = useState<BindingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [otp, setOtp] = useState(SANDBOX_OTP);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [otpMethods, setOtpMethods] = useState<any[]>([]);
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [otpDelivered, setOtpDelivered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<unknown>(null);
  const autoStartedRef = useRef(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authenticate = useCallback(async (sessionArg?: any) => {
    setStatus("auth");
    setError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = sessionArg ?? (sessionRef.current as any);
      const assuranceData = await session.authenticate();
      session.destroy();
      sessionRef.current = null;

      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId, buyerId, assuranceData }),
      });
      setStatus("done");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }, [buyerId, sessionId, tokenId]);

  const startBinding = useCallback(async () => {
    if (!sessionId) {
      setError("Missing sessionId in URL");
      setStatus("error");
      return;
    }
    if (!tokenId) {
      setError("Missing tokenId in URL");
      setStatus("error");
      return;
    }

    setStatus("starting");
    setError(null);
    try {
      const config = await fetchConfig();
      if (config.mockMode) throw new Error("This checkout page is disabled in local mock mode. Open / to prepare a synthetic card.");
      const accessToken = await fetchAccessToken();
      const clientRefId = crypto.randomUUID();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VgsAgenticAuth }: any = await import("../vgs-agentic-auth.js");
      const flow = new VgsAgenticAuth({
        tokenId,
        environment,
        consumerEmail,
        accessToken,
        clientRefId,
        authenticationAmount: amount,
        currencyCode,
        merchantName,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session: any = await flow.startSession(containerRef.current);
      sessionRef.current = session;

      if (session.needsOtp) {
        setOtpMethods(session.otpMethods);
        setSelectedMethodId(session.otpMethods[0]?.identifier ?? "");
        setOtpDelivered(false);
        setStatus("otp");
        return;
      }

      await authenticate(session);
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }, [amount, authenticate, consumerEmail, currencyCode, environment, merchantName, sessionId, tokenId]);

  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    void startBinding();
  }, [startBinding]);

  async function requestOtp() {
    const method = otpMethods.find((m) => m.identifier === selectedMethodId);
    if (!method) {
      setError("Select an OTP method first");
      setStatus("error");
      return;
    }
    setError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = sessionRef.current as any;
      await session.requestOtp(method);
      setOtpDelivered(true);
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }

  async function submitOtp() {
    setError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = sessionRef.current as any;
      await session.submitOtp(otp.trim());
      await authenticate(session);
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex items-center justify-center p-6">
      <div className="bg-white rounded-lg shadow max-w-lg w-full min-h-[640px] p-6 flex flex-col">
        <h1 className="text-xl font-semibold mb-1">Confirm Purchase</h1>
        <p className="text-sm text-gray-500 mb-4">
          {productName} at {merchantName}
        </p>

        <div className="border border-gray-200 rounded p-3 mb-4 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-gray-500">Amount</span>
            <span className="font-medium">{amount} {currency}</span>
          </div>
          <div className="flex justify-between gap-4 mt-1">
            <span className="text-gray-500">Buyer</span>
            <span className="font-mono text-xs break-all">{buyerId || "unknown"}</span>
          </div>
          <div className="flex justify-between gap-4 mt-1">
            <span className="text-gray-500">Card</span>
            <span className="font-medium">{CARD_DETAILS.brand} ending in {CARD_DETAILS.lastFour}</span>
          </div>
          <div className="flex justify-between gap-4 mt-1">
            <span className="text-gray-500">Expiry</span>
            <span className="font-medium">{CARD_DETAILS.expiry}</span>
          </div>
        </div>

        {status === "error" && error && (
          <div className="bg-red-50 border border-red-300 text-red-700 text-sm rounded p-3 mb-4">
            {error}
          </div>
        )}

        {status === "done" && (
          <div>
            <div className="bg-green-50 border border-green-300 text-green-700 text-sm rounded p-3 mb-2">
              Purchase authentication completed.
            </div>
            <p className="text-sm text-gray-500">You can close this tab.</p>
          </div>
        )}

        {(status === "idle" || status === "starting") && (
          <div className="bg-blue-50 border border-blue-200 text-blue-700 text-sm rounded p-3">
            Preparing secure card authentication...
          </div>
        )}

        {status === "otp" && (
          <>
            <div className="mt-3 flex items-end gap-2">
              <Field label="OTP Method">
                <select
                  className="input w-48"
                  value={selectedMethodId}
                  onChange={(e) => setSelectedMethodId(e.target.value)}
                >
                  {otpMethods.map((m) => (
                    <option key={m.identifier} value={m.identifier}>
                      {m.method}
                    </option>
                  ))}
                </select>
              </Field>
              <Button onClick={requestOtp} disabled={!selectedMethodId}>
                {otpDelivered ? "Resend OTP" : "Send OTP"}
              </Button>
            </div>

            {otpDelivered && (
              <div className="mt-3 flex items-end gap-2">
                <Field label="OTP Code">
                  <input className="input w-48" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} />
                </Field>
                <Button onClick={submitOtp}>Submit OTP</Button>
              </div>
            )}
          </>
        )}

        {status === "auth" && (
          <div className="bg-blue-50 border border-blue-200 text-blue-700 text-sm rounded p-3">
            Complete the browser authentication prompt.
          </div>
        )}

        <div
          ref={containerRef}
          className="mt-4 flex min-h-[400px] w-full items-start justify-center overflow-hidden rounded border border-gray-200 bg-gray-50"
        />

        <Row>
          <div />
          <p className="text-xs text-gray-400 mt-4 text-right">Sandbox OTP: {SANDBOX_OTP}</p>
        </Row>
      </div>
    </div>
  );
}
