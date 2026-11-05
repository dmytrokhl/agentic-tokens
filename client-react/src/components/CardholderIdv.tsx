import { useEffect, useRef, useState } from "react";
import { useOtpInput } from "../useOtpInput";
import {
  getStepUpOptions, idvErrorInfo, idvErrorPayload, newClientRefId, otpMethodLabel,
  readOtpDelivery, readOtpVerification, requestOtp, submitOtp, type OtpMethod,
} from "../idv";
import { useAppState, useStepStatus } from "../useAppState";
import { Step } from "./Step";
import { Field, Button } from "./ui";

export function CardholderIdv({ consumerEmail }: { consumerEmail: string }) {
  const { state, setState, log, setLoading, completeStep, goToStep } = useAppState();
  const { loading, done, num } = useStepStatus("idv");
  const context = state.otpContext;
  const mastercard = state.network === "mastercard";
  const [response, setResponse] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [localReference, setLocalReference] = useState(() => newClientRefId());
  const [localMethods, setLocalMethods] = useState<OtpMethod[]>([]);
  const [selected, setSelected] = useState("");
  const [verificationRef, setVerificationRef] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const { otp, setOtp } = useOtpInput(!mastercard);
  const originalRef = context?.clientRefId ?? localReference;
  const methods = context?.methods ?? localMethods;
  const selectedIdentifier = methods.some((method) => method.identifier === selected) ? selected : methods[0]?.identifier ?? "";
  const running = useRef(false);
  const mounted = useRef(true);
  const busy = loading || state.loadingSteps.size > 0;
  const ready = Boolean(state.tokenId && state.completedSteps.has("enroll") && (!mastercard || context));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (running.current) setLoading("idv", false); };
  }, [setLoading]);

  function invalidate() {
    setState((s) => {
      const completedSteps = new Set(s.completedSteps);
      for (const step of ["idv", "agenticEnroll", "intent", "cryptogram", "confirm"] as const) completedSteps.delete(step);
      return { ...s, completedSteps, otpVerifiedTokenId: null, assuranceData: null, intentId: null };
    });
  }

  function fail(err: unknown) {
    const info = idvErrorInfo(err);
    setError(info.error);
    setResponse((previous: unknown) => info.status !== undefined ? idvErrorPayload(err) : previous ?? idvErrorPayload(err));
    if (mastercard && info.status === 422) { setRestartRequired(true); setVerificationRef(null); }
    log(`Step ${num}: Verification request failed${info.status ? ` (HTTP ${info.status})` : ""}`);
  }

  async function run(action: () => Promise<void>) {
    if (!ready || busy || running.current) return;
    running.current = true;
    setLoading("idv", true); setError(""); setNotice(""); setResponse(null);
    try { await action(); }
    finally { if (mounted.current) setLoading("idv", false); running.current = false; }
  }

  async function getOptions() {
    await run(async () => {
      invalidate(); setVerificationRef(null); setLocalMethods([]); setSelected(""); setRestartRequired(false);
      try {
        const ref = newClientRefId();
        const options = await getStepUpOptions(state.tokenId!, ref);
        if (!mounted.current) return;
        setResponse(options.raw);
        if (options.passkeyRequired) throw new Error("This card requires a different verification flow.");
        setLocalReference(ref); setLocalMethods(options.methods);
        if (!options.methods.length) setNotice("No SMS or email options are available. Verification has not been completed.");
      } catch (err) { if (mounted.current) fail(err); }
    });
  }

  async function sendCode() {
    if (!selectedIdentifier || restartRequired) return;
    await run(async () => {
      if (verificationRef) setOtp("");
      invalidate(); setVerificationRef(null);
      log(`Step ${num}: Requesting a verification code...`);
      try {
        // Resends use the original lookup reference, never the session returned by delivery.
        const body = await requestOtp(state.tokenId!, originalRef, selectedIdentifier);
        if (!mounted.current) return;
        setResponse(body);
        setVerificationRef(readOtpDelivery(body, selectedIdentifier, originalRef));
        setNotice("Code sent. Enter the code you received.");
      } catch (err) { if (mounted.current) fail(err); }
    });
  }

  async function verifyCode() {
    if (!verificationRef || !otp.trim() || restartRequired) return;
    await run(async () => {
      const submittedOtp = otp.trim();
      try {
        const body = await submitOtp(state.tokenId!, verificationRef, consumerEmail, submittedOtp);
        if (!mounted.current) return;
        setResponse(body);
        const result = readOtpVerification(body, state.tokenId!, verificationRef);
        setVerificationRef(result.clientRefId);
        if (result.status === "verified") {
          setState((s) => ({ ...s, assuranceData: null, otpVerifiedTokenId: state.tokenId }));
          setVerificationRef(null);
          log(`Step ${num}: Cardholder verified`);
          completeStep("idv");
        } else if (result.status === "pending") {
          setNotice("Verification is still pending. Enter the code again when ready.");
        } else {
          setVerificationRef(null);
          setError("Verification was not approved. Request a new code to try again.");
        }
      } catch (err) { if (mounted.current) fail(err); }
      finally { if (mounted.current) setOtp(""); }
    });
  }

  function selectMethod(identifier: string) {
    setSelected(identifier); setVerificationRef(null); setOtp(""); setError(""); setNotice("");
    invalidate();
  }

  return <Step stepKey="idv" title="Cardholder Verification (ID&V)" response={response}>
    <p className="text-sm text-gray-500">Choose where to receive a code, then enter it to verify the cardholder.</p>
    {done && <p role="status" className="text-sm text-green-700">Cardholder verified.</p>}
    {!context && !mastercard && <Button onClick={getOptions} disabled={busy || !ready}>Get Verification Options</Button>}
    {mastercard && (!context || restartRequired) && <Button variant="secondary" onClick={() => goToStep("otpOptions")} disabled={busy}>
      Get New Verification Options
    </Button>}
    {methods.length > 0 && <>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Send code by">
          <select aria-label="Send code by" className="input w-64" value={selectedIdentifier} disabled={busy || restartRequired}
            onChange={(e) => selectMethod(e.target.value)}>
            {methods.map((method) => <option key={method.identifier} value={method.identifier}>{otpMethodLabel(method)}</option>)}
          </select>
        </Field>
        <Button onClick={sendCode} disabled={busy || !ready || !selectedIdentifier || restartRequired}>
          {verificationRef ? "Resend Code" : "Send Code"}
        </Button>
      </div>
      {verificationRef && <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Verification code">
          <input aria-label="Verification code" className="input w-48" autoComplete="one-time-code" inputMode="numeric"
            placeholder="Code from SMS or email" value={otp} disabled={busy} onChange={(e) => setOtp(e.target.value)} />
        </Field>
        <Button onClick={verifyCode} disabled={busy || !ready || !otp.trim()}>Verify Code</Button>
      </div>}
      {mastercard && !restartRequired && <Button variant="secondary" onClick={() => goToStep("otpOptions")} disabled={busy}>
        Get New Verification Options
      </Button>}
    </>}
    {notice && <p role="status" className="text-sm text-gray-600">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </Step>;
}
