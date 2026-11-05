import { useEffect, useRef, useState } from "react";
import { getStepUpOptions, idvErrorInfo, idvErrorPayload, newClientRefId, otpMethodLabel } from "../idv";
import { useAppState, useStepStatus } from "../useAppState";
import { Step } from "./Step";
import { Button } from "./ui";

/** Mastercard adds one lookup step; sending and checking the code use the shared form. */
export function OtpOptions() {
  const { state, setState, setLoading, completeStep, goToStep, log } = useAppState();
  const { num, loading } = useStepStatus("otpOptions");
  const [response, setResponse] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (running.current) setLoading("otpOptions", false); };
  }, [setLoading]);

  async function getOptions() {
    if (!state.tokenId || !state.completedSteps.has("enroll") || state.loadingSteps.size || running.current) return;
    running.current = true;
    setLoading("otpOptions", true);
    setError(""); setEmpty(false); setResponse(null);
    setState((s) => {
      const completedSteps = new Set(s.completedSteps);
      for (const step of ["otpOptions", "idv", "cryptogram"] as const) completedSteps.delete(step);
      return { ...s, completedSteps, otpContext: null, otpVerifiedTokenId: null };
    });
    log(`Step ${num}: Getting verification options...`);
    try {
      const clientRefId = newClientRefId("mastercard");
      const options = await getStepUpOptions(state.tokenId, clientRefId);
      if (!mounted.current) return;
      setResponse(options.raw);
      if (options.passkeyRequired) throw new Error("This card requires a different verification flow.");
      if (!options.methods.length) { setEmpty(true); return; }
      setState((s) => ({ ...s, otpContext: { clientRefId, methods: options.methods } }));
      log(`Step ${num}: ${options.methods.length} verification options available`);
      completeStep("otpOptions");
    } catch (err) {
      if (!mounted.current) return;
      const info = idvErrorInfo(err);
      setError(info.error);
      setResponse((previous: unknown) => info.status !== undefined ? idvErrorPayload(err) : previous ?? idvErrorPayload(err));
      log(`Step ${num}: Could not get verification options`);
    } finally {
      if (mounted.current) setLoading("otpOptions", false);
      running.current = false;
    }
  }

  return <Step stepKey="otpOptions" title="Get Verification Options" response={response}>
    <p className="text-sm text-gray-500">Find the SMS or email options available for this card.</p>
    <Button onClick={getOptions} disabled={loading || state.loadingSteps.size > 0 || !state.tokenId || !state.completedSteps.has("enroll")}>
      {loading ? "Getting options…" : state.otpContext ? "Refresh Options" : "Get Verification Options"}
    </Button>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {empty && <p role="status" className="text-sm text-amber-700">No SMS or email options are available. Verification has not been completed.</p>}
    {state.otpContext && <>
      <p className="text-sm text-gray-600">{state.otpContext.methods.map(otpMethodLabel).join(" · ")}</p>
      <Button variant="secondary" onClick={() => goToStep("idv")} disabled={state.loadingSteps.size > 0}>Continue to Verification</Button>
    </>}
  </Step>;
}
