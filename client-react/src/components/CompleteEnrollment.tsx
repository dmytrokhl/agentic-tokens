import { useState } from "react";
import { completeEnrollment, idvErrorInfo, idvErrorPayload } from "../idv";
import { useAppState, useStepStatus } from "../useAppState";
import { Step } from "./Step";
import { Field, Button } from "./ui";

interface Props {
  consumerEmail: string;
}

/**
 * Finish enrolling the token after cardholder verification (ID&V flow only).
 *
 * Visa requires this to run *after* verification, which is why it is its own step rather
 * than part of "Enroll Agentic Token". Until it succeeds the token cannot create intents.
 * The call itself is `completeEnrollment()` in `src/idv.ts`.
 */
export function CompleteEnrollment({ consumerEmail }: Props) {
  const { state, setState, log, setLoading, completeStep } = useAppState();
  const { loading, num } = useStepStatus("agenticEnroll");
  const [response, setResponse] = useState<unknown>(null);

  async function handleComplete() {
    setLoading("agenticEnroll", true);
    log(`Step ${num}: Completing enrollment...`);
    try {
      const data = await completeEnrollment(state.tokenId!, consumerEmail);
      setResponse(data);
      const status = (data as { data?: { attributes?: { status?: string } } })?.data?.attributes?.status;
      log(`Step ${num}: Enrollment complete — status=${status ?? "unknown"}`);
      completeStep("agenticEnroll");
    } catch (err) {
      const info = idvErrorInfo(err);
      log(`Step ${num}: Error — ${info.error}`);
      setResponse(idvErrorPayload(err));
      setLoading("agenticEnroll", false);
    }
  }

  return (
    <Step stepKey="agenticEnroll" title="Complete Enrollment" response={response}>
      <p className="text-xs text-gray-500">
        Runs once per token, after verification and before creating an intent.
      </p>
      <Field label="Token ID">
        <input
          className="input"
          value={state.tokenId ?? ""}
          onChange={(e) => setState((s) => ({ ...s, tokenId: e.target.value }))}
        />
      </Field>
      <Field label="Consumer Email (same as enrollment)">
        <input className="input" value={consumerEmail} readOnly />
      </Field>
      <Button onClick={handleComplete} disabled={loading}>Complete Enrollment</Button>
    </Step>
  );
}
