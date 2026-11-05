import { Fragment, useState, type ReactNode } from "react";
import { AppStateProvider, useAppState } from "./useAppState";
import { CARDHOLDER_VERIFICATION_META, type CardholderVerification, type StepKey } from "./flow";
import { CreateCard } from "./components/CreateCard";
import { EnrollToken } from "./components/EnrollToken";
import { OtpOptions } from "./components/OtpOptions";
import { DeviceBinding } from "./components/DeviceBinding";
import { CardholderIdv } from "./components/CardholderIdv";
import { CompleteEnrollment } from "./components/CompleteEnrollment";
import { CreateIntent } from "./components/CreateIntent";
import { GetCryptogram } from "./components/GetCryptogram";
import { ConfirmTransaction } from "./components/ConfirmTransaction";
import { DeleteEnrollment } from "./components/DeleteEnrollment";
import { Log } from "./components/Log";

export default function App() {
  return (
    <AppStateProvider>
      <AppContent />
    </AppStateProvider>
  );
}

function AppContent() {
  const { state, flow, logs, reset } = useAppState();
  const [consumerEmail, setConsumerEmail] = useState("user@example.com");

  function handleReset() {
    reset();
    setConsumerEmail("user@example.com");
  }

  // The block for every step the app knows how to render. Which of them appear, in what
  // order, and under which number all come from `flow` — this file never decides. Adding a
  // StepKey is a compile error here until it gets a block.
  const stepBlocks: Record<StepKey, ReactNode> = {
    card: <CreateCard />,
    enroll: <EnrollToken consumerEmail={consumerEmail} setConsumerEmail={setConsumerEmail} />,
    otpOptions: <OtpOptions key={`${state.cardId}:${state.tokenId}:${state.enrollmentVersion}`} />,
    deviceBinding: <DeviceBinding consumerEmail={consumerEmail} />,
    idv: <CardholderIdv key={`${state.cardId}:${state.tokenId}:${state.enrollmentVersion}:${state.otpContext?.clientRefId ?? "lookup"}`} consumerEmail={consumerEmail} />,
    agenticEnroll: <CompleteEnrollment consumerEmail={consumerEmail} />,
    intent: <CreateIntent />,
    cryptogram: <GetCryptogram key={`${state.network}:${state.cardId}:${state.tokenId}:${state.enrollmentVersion}:${state.otpVerifiedTokenId}`} />,
    confirm: <ConfirmTransaction />,
    deleteEnrollment: <DeleteEnrollment key={state.cardId ?? "amex"} />,
  };

  return (
    <div className="max-w-[860px] mx-auto p-6 bg-gray-50 min-h-screen text-gray-900">
      <div className="flex justify-between items-baseline">
        <h1 className="text-2xl font-bold mb-1">Agentic Tokens API — Sample App</h1>
        <button
          className="bg-gray-500 text-white text-xs px-3.5 py-1.5 rounded cursor-pointer hover:bg-gray-600"
          onClick={handleReset}
        >
          Start Over
        </button>
      </div>
      <p className="text-gray-500 text-sm mb-4">Step-by-step integration reference for the VGS Agentic Tokens API</p>

      <FlowIndicator verification={state.network === "mastercard" && state.tokenId ? "otp" : state.cardholderVerification} />

      {flow.map((key) => (
        <Fragment key={key}>{stepBlocks[key]}</Fragment>
      ))}
      <Log entries={logs} />
    </div>
  );
}

function FlowIndicator({ verification }: { verification: CardholderVerification | null }) {
  // Read-only on purpose: the flow is decided server-side from the vault's configuration and
  // reported by the enroll response, so there is nothing here for the user to choose. Null
  // until that response arrives.
  const meta = verification && CARDHOLDER_VERIFICATION_META[verification];
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Cardholder verification:</span>
        <span className={`text-xs px-2 py-1 rounded ${meta?.badgeCss ?? "bg-gray-100 text-gray-600"}`}>
          {meta?.label ?? "determined at enrollment"}
        </span>
      </div>
      <p className="text-xs text-gray-500 mt-1">
        {meta?.hint ??
          "The enroll response reports cardholder_verification and agentic_enrollment_required; the remaining steps follow from those."}
      </p>
    </div>
  );
}
