import { useState } from "react";
import { deleteAmexEnrollment } from "../amex";
import { useAppState, useStepStatus } from "../useAppState";
import { Step } from "./Step";
import { Field, Button } from "./ui";

export function DeleteEnrollment() {
  const { state, setState, log, setLoading } = useAppState();
  const { loading } = useStepStatus("deleteEnrollment");
  const [enrollmentId, setEnrollmentId] = useState(state.tokenId ?? "");
  const [response, setResponse] = useState<unknown>(null);
  const [responseMeta, setResponseMeta] = useState<string | null>(null);
  const [deletedId, setDeletedId] = useState<string | null>(null);
  const [lastTokenId, setLastTokenId] = useState(state.tokenId);

  // Keep the deletion response after clearing the token; reset it for a new enrollment.
  if (state.tokenId !== lastTokenId) {
    setLastTokenId(state.tokenId);
    if (state.tokenId) {
      setEnrollmentId(state.tokenId);
      setResponse(null);
      setResponseMeta(null);
      setDeletedId(null);
    }
  }

  async function handleDelete() {
    const id = enrollmentId.trim();
    if (!id || state.loadingSteps.size > 0) return;
    setLoading("deleteEnrollment", true);
    setDeletedId(null);
    setState((s) => {
      const completedSteps = new Set(s.completedSteps);
      completedSteps.delete("deleteEnrollment");
      return { ...s, completedSteps };
    });
    log(`Unenrollment: Deleting Amex enrollment ${id}...`);
    try {
      const result = await deleteAmexEnrollment(id);
      setResponse(result.body);
      setResponseMeta(`API response · HTTP ${result.status}`);
      if (result.ok && result.body?.data?.id === id && result.body.data.attributes?.status === "deleted") {
        setDeletedId(id);
        log(`Unenrollment: Enrollment deleted — ${id}`);
        setState((s) => {
          if (s.tokenId !== id) {
            return { ...s, completedSteps: new Set([...s.completedSteps, "deleteEnrollment"]) };
          }
          return {
            ...s,
            tokenId: null,
            intentId: null,
            assuranceData: null,
            otpContext: null,
            otpVerifiedTokenId: null,
            amexDeviceContext: null,
            cardholderVerification: null,
            agenticEnrollmentRequired: false,
            completedSteps: new Set([
              ...[...s.completedSteps].filter((step) => step === "card"),
              "deleteEnrollment",
            ]),
            activeStep: "enroll",
          };
        });
      } else {
        log(`Unenrollment: Deletion not confirmed — HTTP ${result.status}`);
      }
    } catch (err) {
      const detail = (err as Error).message;
      setResponse({ error: "client_error", detail });
      setResponseMeta("Client error before API response");
      log(`Unenrollment: Error — ${detail}`);
    } finally {
      setLoading("deleteEnrollment", false);
    }
  }

  if (!state.completedSteps.has("enroll") && !deletedId) return null;

  return (
    <Step key={state.tokenId ?? lastTokenId ?? deletedId} stepKey="deleteEnrollment" title="Unenrollment (Amex)" response={response} responseMeta={responseMeta} manual>
      <Field label="Enrollment ID">
        <input className="input" value={enrollmentId} disabled={loading} onChange={(e) => setEnrollmentId(e.target.value)} />
      </Field>
      <p className="text-xs text-gray-500">Prefilled with the latest enrollment from this flow. Paste another enrollment ID to delete it.</p>
      <Button onClick={handleDelete} disabled={state.loadingSteps.size > 0 || !enrollmentId.trim() || deletedId === enrollmentId.trim()}>
        {loading ? "Unenrolling…" : "Unenroll"}
      </Button>
      {deletedId && <p className="text-sm text-green-700">Enrollment {deletedId} deleted. You can enroll the card again.</p>}
    </Step>
  );
}
