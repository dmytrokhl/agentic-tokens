import { CurrencyField } from "./CurrencyField";
import { useEffect, useRef, useState } from "react";
import { fetchAccessToken } from "../api";
import { useAppState, useStepStatus } from "../useAppState";
import { Step } from "./Step";
import { Field, Row, Button } from "./ui";

const SANDBOX_OTP = "456789";

interface Props {
  consumerEmail: string;
}

export function DeviceBinding({ consumerEmail }: Props) {
  const { state, setState, log, setLoading, completeStep, sessionRef } = useAppState();
  const { loading, num } = useStepStatus("deviceBinding");
  const [response, setResponse] = useState<unknown>(null);
  const [environment, setEnvironment] = useState(import.meta.env.VITE_DEFAULT_ENVIRONMENT || "sandbox");
  const [authAmount, setAuthAmount] = useState("100");
  const [currencyCode, setCurrencyCode] = useState("840");
  const [merchantName, setMerchantName] = useState("VGS");
  const [otpVisible, setOtpVisible] = useState(false);
  const [otp, setOtp] = useState(SANDBOX_OTP);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [otpMethods, setOtpMethods] = useState<any[]>([]);
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [otpDelivered, setOtpDelivered] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // This step now unmounts when the enroll response swaps the flow (device binding gives way to
  // ID&V, or to nothing at all). A session started before that swap has to be closed here —
  // handleAuthenticate and reset() are the only other places that destroy one.
  useEffect(
    () => () => {
      const session = sessionRef.current as { destroy?: () => void } | null;
      session?.destroy?.();
      sessionRef.current = null;
    },
    [sessionRef],
  );

  async function handleStartSession() {
    setLoading("deviceBinding", true);
    setSessionStarted(true);
    log(`Step ${num}: Starting device binding session...`);
    try {
      const accessToken = await fetchAccessToken();
      const clientRefId = crypto.randomUUID();
      log(`Step ${num}: clientRefId=${clientRefId}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VgsAgenticAuth }: any = await import("../vgs-agentic-auth.js");
      const flow = new VgsAgenticAuth({
        tokenId: state.tokenId,
        environment,
        consumerEmail,
        accessToken,
        clientRefId,
        authenticationAmount: authAmount,
        currencyCode,
        merchantName,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session: any = await flow.startSession(containerRef.current);
      sessionRef.current = session;
      log(`Step ${num}: Session created. needsOtp=${session.needsOtp} needsPasskey=${session.needsPasskey}`);

      // The only place iframe visibility is decided. The sample-only sizing in
      // vgs-agentic-auth.js renders it inline; a passkey-exempt vault runs no ceremony, so
      // there is nothing for the cardholder to see.
      if (session.needsPasskey === false) {
        session.iframe.style.display = "none";
      }

      if (session.needsOtp) {
        setOtpMethods(session.otpMethods);
        setSelectedMethodId(session.otpMethods[0]?.identifier ?? "");
        setOtpDelivered(false);
        setOtpVisible(true);
        setLoading("deviceBinding", false);
      } else {
        await handleAuthenticate(session);
      }
    } catch (err: unknown) {
      const e = err as { message: string; code?: string; status?: number };
      log(`Step ${num}: Session error — ` + e.message);
      setResponse({ error: e.message, code: e.code, status: e.status });
      setSessionStarted(false);
      setLoading("deviceBinding", false);
    }
  }

  async function handleRequestOtp() {
    const method = otpMethods.find((m) => m.identifier === selectedMethodId);
    if (!method) {
      log(`Step ${num}: Pick an OTP method first`);
      return;
    }
    setLoading("deviceBinding", true);
    log(`Step ${num}: Requesting OTP via ${method.method}...`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = sessionRef.current as any;
    try {
      await session.requestOtp(method);
      setOtpDelivered(true);
      log(`Step ${num}: OTP delivery requested`);
      setLoading("deviceBinding", false);
    } catch (err: unknown) {
      const e = err as { message: string; code?: string };
      log(`Step ${num}: requestOtp error — ` + e.message);
      setResponse({ error: e.message, code: e.code });
      setLoading("deviceBinding", false);
    }
  }

  async function handleSubmitOtp() {
    setLoading("deviceBinding", true);
    log(`Step ${num}: Submitting OTP...`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = sessionRef.current as any;
    try {
      await session.submitOtp(otp.trim());
      setOtpVisible(false);
      log(`Step ${num}: OTP accepted`);
      await handleAuthenticate(session);
    } catch (err: unknown) {
      const e = err as { message: string; code?: string };
      log(`Step ${num}: OTP error — ` + e.message);
      setResponse({ error: e.message, code: e.code });
      setLoading("deviceBinding", false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleAuthenticate(sessionArg?: any) {
    setLoading("deviceBinding", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = sessionArg ?? (sessionRef.current as any);
    // Passkey-exempt: authenticate() resolves immediately without a ceremony and the backend
    // synthesizes the assuranceData waiver, so there is nothing to do but say so.
    log(
      session.needsPasskey === false
        ? `Step ${num}: Passkey exempt — skipping passkey ceremony (backend synthesizes the waiver)`
        : `Step ${num}: Running FIDO ceremony...`,
    );
    try {
      const assuranceData = await session.authenticate();
      session.destroy();
      sessionRef.current = null;
      setState((s) => ({ ...s, assuranceData }));
      setResponse({ assuranceData });
      log(`Step ${num}: Device binding complete`);
      completeStep("deviceBinding");
    } catch (err: unknown) {
      const e = err as { message: string; code?: string };
      log(`Step ${num}: FIDO error — ` + e.message);
      setResponse({ error: e.message, code: e.code });
      setLoading("deviceBinding", false);
    }
  }

  return (
    <Step stepKey="deviceBinding" title="Device Binding (FIDO / OTP)" response={response}>
      <Field label="Token ID">
        <input className="input" value={state.tokenId ?? ""} onChange={(e) => setState((s) => ({ ...s, tokenId: e.target.value }))} />
      </Field>
      <Field label="Environment">
        <select className="input" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          <option value="local">Local</option>
          <option value="dev">Dev</option>
          <option value="sandbox">Sandbox</option>
          <option value="live">Live</option>
        </select>
      </Field>
      <Row>
        <Field label="Authentication Amount">
          <input className="input" value={authAmount} onChange={(e) => setAuthAmount(e.target.value)} />
        </Field>
        <CurrencyField numeric value={currencyCode} onChange={setCurrencyCode} />
      </Row>
      <Field label="Merchant Name (optional)">
        <input className="input" placeholder="e.g. Best Buy" value={merchantName} onChange={(e) => setMerchantName(e.target.value)} />
      </Field>
      <Button onClick={handleStartSession} disabled={sessionStarted || loading}>Start Session</Button>
      <p className="text-xs text-gray-500 mt-1">
        The library reads <code>needsOtp</code> / <code>needsPasskey</code> from the device-attestation
        response, so the server decides which prompts run. Vaults that verify with a one-time code
        instead of a passkey use the <strong>Cardholder ID&amp;V</strong> mode in the header.
      </p>

      {otpVisible && (
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
            <Button onClick={handleRequestOtp} disabled={loading || !selectedMethodId}>
              {otpDelivered ? "Resend OTP" : "Send OTP"}
            </Button>
          </div>

          {otpDelivered && (
            <div className="mt-3 flex items-end gap-2">
              <Field label="OTP Code">
                <input className="input w-48" maxLength={6} placeholder={SANDBOX_OTP} value={otp} onChange={(e) => setOtp(e.target.value)} />
              </Field>
              <Button onClick={handleSubmitOtp} disabled={loading}>Submit OTP</Button>
            </div>
          )}
        </>
      )}

      <div ref={containerRef} className="mt-3" />
    </Step>
  );
}
