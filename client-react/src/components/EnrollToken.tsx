import { useState } from "react";
import { AMEX_ENROLLMENT_EXAMPLE, deleteAmexEnrollment, enrollmentAttributes, isEnrollmentAlreadyExists } from "../amex";
import { apiResponse } from "../api";
import { useAppState, useStepStatus } from "../useAppState";
import { flowFromEnrollResponse, reconcileNetwork } from "../flow";
import { Step } from "./Step";
import { Field, Button } from "./ui";

interface Props {
  consumerEmail: string;
  setConsumerEmail: (v: string) => void;
}

interface EnrollApiBody {
  data?: {
    id?: string;
    attributes?: {
      client_ref_id?: string;
      stepUpRequest?: Array<{ method: string; identifier: string; value?: string }>;
    };
  };
  error?: string;
  detail?: string;
}

export function EnrollToken({ consumerEmail, setConsumerEmail }: Props) {
  const { state, setState, log, setLoading, setFlowFromEnrollment, completeStep } = useAppState();
  const { loading, num } = useStepStatus("enroll");
  const [response, setResponse] = useState<unknown>(null);
  const [responseMeta, setResponseMeta] = useState<string | null>(null);

  const [consumerId, setConsumerId] = useState(AMEX_ENROLLMENT_EXAMPLE.consumerId ?? "");
  const [firstName, setFirstName] = useState(AMEX_ENROLLMENT_EXAMPLE.firstName);
  const [lastName, setLastName] = useState(AMEX_ENROLLMENT_EXAMPLE.lastName);
  const [deviceId, setDeviceId] = useState(AMEX_ENROLLMENT_EXAMPLE.deviceId);
  const [ipAddress, setIpAddress] = useState(AMEX_ENROLLMENT_EXAMPLE.ipAddress);
  const [nameCount, setNameCount] = useState(AMEX_ENROLLMENT_EXAMPLE.distinctBillingLastNameCount);
  const [formFactor, setFormFactor] = useState(AMEX_ENROLLMENT_EXAMPLE.formFactor);
  const isAmex = state.network === "amex";
  const [conflictCardId, setConflictCardId] = useState<string | null>(null);
  const [conflictEnrollmentId, setConflictEnrollmentId] = useState("");
  const [deletedEnrollmentId, setDeletedEnrollmentId] = useState<string | null>(null);
  const showConflictDeletion = isAmex && conflictCardId !== null && conflictCardId === state.cardId;

  async function handleEnroll() {
    setLoading("enroll", true);
    setConflictCardId(null);
    setDeletedEnrollmentId(null);
    log(`Step ${num}: Enrolling token...`);
    try {
      const result = await apiResponse<EnrollApiBody>("POST", `/cards/${state.cardId}/agentic-tokens`, {
        data: {
          type: "agentic_tokens",
          attributes: enrollmentAttributes(consumerEmail, isAmex ? {
            consumerId, firstName, lastName, deviceId, ipAddress, distinctBillingLastNameCount: nameCount,
            language: navigator.language, browserUserAgent: navigator.userAgent,
            formFactor, agent: state.agentContext,
          } : undefined),
        },
      });
      const data = result.body;
      const tokenId = data?.data?.id;
      setResponse(data);
      setResponseMeta(`API response · HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ""}`);
      if (result.ok && tokenId) {
        // The enroll response is authoritative — reconcile the network against
        // it, in case PAN-based detection at card creation guessed wrong. The
        // network-specific markers live in reconcileNetwork (see flow.ts).
        const network = reconcileNetwork(data, state.network);
        const attributes = data.data?.attributes;
        const otpContext = attributes?.client_ref_id && attributes.stepUpRequest?.length
          ? {
              clientRefId: attributes.client_ref_id,
              methods: attributes.stepUpRequest,
            }
          : null;
        setState((s) => ({
          ...s, tokenId, network, otpContext, consumerEmail,
          enrollmentVersion: s.enrollmentVersion + 1,
          otpVerifiedTokenId: null, intentId: null, assuranceData: null,
          completedSteps: new Set([...s.completedSteps].filter((step) => step === "card")),
          amexDeviceContext: isAmex && state.cardId ? {
            cardId: state.cardId, deviceId, ipAddress, formFactor,
            language: navigator.language, browserUserAgent: navigator.userAgent,
          } : null,
        }));
        log(`Step ${num}: Token enrolled — ${tokenId} (${network})`);

        // The server tells us which flow this vault uses; the remaining steps follow from
        // these two fields (see flowFromEnrollResponse for the field names and defaults).
        const { verification, agenticEnrollmentRequired } = flowFromEnrollResponse(data);
        log(
          `Step ${num}: cardholder_verification=${verification} ` +
            `agentic_enrollment_required=${agenticEnrollmentRequired}`,
        );
        setFlowFromEnrollment(verification, agenticEnrollmentRequired);
        completeStep("enroll");
      } else {
        if (isAmex && isEnrollmentAlreadyExists(result.status, data)) {
          setConflictCardId(state.cardId);
          setConflictEnrollmentId(state.tokenId ?? "");
        }
        log(`Step ${num}: API returned HTTP ${result.status} — ${data?.error ?? JSON.stringify(data)}`);
        setLoading("enroll", false);
      }
    } catch (err) {
      log(`Step ${num}: Error — ` + (err as Error).message);
      setResponse({ error: "client_error", detail: (err as Error).message });
      setResponseMeta("Client error before API response");
      setLoading("enroll", false);
    }
  }

  async function handleDeleteEnrollment(enrollmentId: string) {
    const id = enrollmentId.trim();
    if (!isAmex || !id || state.loadingSteps.size > 0) return;
    setState((s) => ({ ...s, activeStep: "enroll" }));
    setLoading("enroll", true);
    setDeletedEnrollmentId(null);
    log(`Step ${num}: Deleting existing Amex enrollment ${id}...`);
    try {
      const result = await deleteAmexEnrollment(id);
      setResponse(result.body);
      setResponseMeta(`Delete enrollment · HTTP ${result.status}`);
      if (result.ok && result.body?.data?.id === id && result.body.data.attributes?.status === "deleted") {
        setDeletedEnrollmentId(id);
        setState((s) => s.tokenId !== id ? s : {
          ...s,
          tokenId: null,
          intentId: null,
          assuranceData: null,
          otpContext: null,
          otpVerifiedTokenId: null,
          amexDeviceContext: null,
          cardholderVerification: null,
          agenticEnrollmentRequired: false,
          completedSteps: new Set([...s.completedSteps].filter((step) => step === "card")),
          activeStep: "enroll",
        });
        log(`Step ${num}: Enrollment deleted — ${id}. Retry enrollment.`);
      } else {
        log(`Step ${num}: Deletion not confirmed — HTTP ${result.status}`);
      }
    } catch (err) {
      const detail = (err as Error).message;
      setResponse({ error: "client_error", detail });
      setResponseMeta("Client error before API response");
      log(`Step ${num}: Error — ${detail}`);
    } finally {
      setLoading("enroll", false);
    }
  }

  return (
    <Step stepKey="enroll" title="Enroll Agentic Token" response={response} responseMeta={responseMeta}>
      <Field label="Card ID">
        <input className="input" value={state.cardId ?? ""} onChange={(e) => setState((s) => ({ ...s, cardId: e.target.value }))} />
      </Field>
      <Field label="Consumer Email">
        <input className="input" value={consumerEmail} onChange={(e) => setConsumerEmail(e.target.value)} />
      </Field>
      {isAmex && <>
        <Field label="Consumer account ID (optional)"><input className="input" value={consumerId} onChange={(e) => setConsumerId(e.target.value)} /></Field>
        <Field label="Cardholder first name"><input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field>
        <Field label="Cardholder last name"><input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field>
        <Field label="Agent name"><input className="input" value={state.agentContext.agent_name} onChange={(e) => setState((s) => ({ ...s, agentContext: { ...s.agentContext, agent_name: e.target.value } }))} /></Field>
        <Field label="Device ID"><input className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} /></Field>
        <Field label="Device IP address"><input className="input" value={ipAddress} onChange={(e) => setIpAddress(e.target.value)} /></Field>
        <Field label="Device form factor"><select className="input" value={formFactor} onChange={(e) => setFormFactor(e.target.value)}><option value="">Select device</option><option value="DESKTOP">Desktop</option><option value="MOBILE">Mobile</option><option value="TABLET">Tablet</option></select></Field>
        <Field label="Distinct billing last names on the account"><input className="input" inputMode="numeric" value={nameCount} onChange={(e) => setNameCount(e.target.value)} /></Field>
        <p className="text-xs text-gray-500 mt-2">Prefilled with sample account, device and agent details from the ACE 1.1 spec. You can edit them before enrolling. Browser language and user agent come from this browser.</p>
      </>}
      <Button onClick={handleEnroll} disabled={loading}>Enroll</Button>
      {deletedEnrollmentId && <p className="text-sm text-green-700">Enrollment {deletedEnrollmentId} deleted. Click Enroll to try again.</p>}
      {showConflictDeletion && <div className="mt-3 border-t border-gray-200 pt-2">
        <Field label="Existing enrollment ID">
          <input className="input" value={conflictEnrollmentId} disabled={loading} onChange={(e) => setConflictEnrollmentId(e.target.value)} />
        </Field>
        <p className="text-xs text-gray-500">The API did not return the existing enrollment ID. This field uses the latest ID from this flow when available; replace it with the enrollment ID you want to delete.</p>
        <Button onClick={() => handleDeleteEnrollment(conflictEnrollmentId)} disabled={state.loadingSteps.size > 0 || !conflictEnrollmentId.trim() || deletedEnrollmentId === conflictEnrollmentId.trim()}>
          Delete Enrollment
        </Button>
      </div>}
    </Step>
  );
}
