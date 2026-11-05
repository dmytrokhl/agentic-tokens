import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  DEFAULT_NETWORK,
  stepsFor,
  type CardholderVerification,
  type Network,
  type StepKey,
} from "./flow";

import { AMEX_ENROLLMENT_EXAMPLE } from "./amex";

export type { CardholderVerification, Network, StepKey } from "./flow";

export interface OtpContext {
  clientRefId: string;
  methods: Array<{ method: string; identifier: string; value?: string }>;
}

export interface AppState {
  agentContext: import("./amex").AgentContext;
  amexDeviceContext: (import("./amex").PaymentDeviceContext & { cardId: string }) | null;
  consumerEmail: string;
  cardId: string | null;
  tokenId: string | null;
  enrollmentVersion: number;
  otpVerifiedTokenId: string | null;
  intentId: string | null;
  assuranceData: unknown[] | null;
  /** Resolved card network — drives which steps are shown. Defaults to visa. */
  network: Network;
  /**
   * The two flow facts reported by the enroll response, which decide the remaining steps.
   * `cardholderVerification` is null until `setFlowFromEnrollment` reports the real value —
   * `stepsFor` assumes the default in the meantime and the header says "determined at enrollment".
   */
  cardholderVerification: CardholderVerification | null;
  agenticEnrollmentRequired: boolean;
  /** Optional challenge returned by enrollment; older responses omit it. */
  otpContext: OtpContext | null;
  /** Which step is currently active */
  activeStep: StepKey;
  /** Steps that have been completed */
  completedSteps: Set<StepKey>;
  /** Steps currently loading */
  loadingSteps: Set<StepKey>;
}

function initialState(): AppState {
  return {
    agentContext: { ...AMEX_ENROLLMENT_EXAMPLE.agent },
    amexDeviceContext: null,
    consumerEmail: "",
    cardId: null,
    tokenId: null,
    enrollmentVersion: 0,
    otpVerifiedTokenId: null,
    intentId: null,
    assuranceData: null,
    network: DEFAULT_NETWORK,
    cardholderVerification: null,
    agenticEnrollmentRequired: false,
    otpContext: null,
    activeStep: "card",
    completedSteps: new Set(),
    loadingSteps: new Set(),
  };
}

export type LogFn = (msg: string) => void;

interface AppStateContextValue {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
  /** The ordered steps of the active flow — the single source of both order and numbering. */
  flow: StepKey[];
  logs: string[];
  log: LogFn;
  setLoading: (step: StepKey, on: boolean) => void;
  setFlowFromEnrollment: (verification: CardholderVerification, agenticEnrollmentRequired: boolean) => void;
  completeStep: (step: StepKey) => void;
  goToStep: (step: StepKey) => void;
  reset: () => void;
  sessionRef: RefObject<unknown>;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialState);
  const [logs, setLogs] = useState<string[]>([]);
  const sessionRef = useRef<unknown>(null);

  const log: LogFn = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${ts}] ${msg}`]);
  }, []);

  const setLoading = useCallback((step: StepKey, on: boolean) => {
    setState((s) => {
      const next = new Set(s.loadingSteps);
      if (on) next.add(step);
      else next.delete(step);
      return { ...s, loadingSteps: next };
    });
  }, []);

  const completeStep = useCallback((step: StepKey) => {
    setState((s) => {
      const completed = new Set(s.completedSteps);
      completed.add(step);
      const loading = new Set(s.loadingSteps);
      loading.delete(step);
      const flow = stepsFor(s.network, s.cardholderVerification, s.agenticEnrollmentRequired);
      const idx = flow.indexOf(step);
      // Unenrollment is optional and opened manually, never an automatic next step.
      const candidate = idx >= 0 ? flow[idx + 1] : undefined;
      const next = candidate && candidate !== "deleteEnrollment" ? candidate : step;
      return {
        ...s,
        completedSteps: completed,
        loadingSteps: loading,
        activeStep: next,
      };
    });
  }, []);

  // Applying the enroll response can swap the step list (e.g. device binding gives way to
  // ID&V). Only the facts are stored here; the caller's following completeStep("enroll") is
  // what advances activeStep, and it recomputes the flow from these new values.
  const setFlowFromEnrollment = useCallback(
    (verification: CardholderVerification, agenticEnrollmentRequired: boolean) => {
      setState((s) => ({ ...s, cardholderVerification: verification, agenticEnrollmentRequired }));
    },
    [],
  );

  const goToStep = useCallback((step: StepKey) => {
    setState((s) => (s.activeStep === step ? s : { ...s, activeStep: step }));
  }, []);

  const reset = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = sessionRef.current as any;
    if (session?.destroy) session.destroy();
    sessionRef.current = null;
    // The flow comes from the next enroll response, so drop back to the assumed default.
    setState(initialState());
    setLogs([]);
  }, []);

  // Recomputed only when one of the three flow facts changes, not on every log line.
  const flow = useMemo(
    () => stepsFor(state.network, state.cardholderVerification, state.agenticEnrollmentRequired),
    [state.network, state.cardholderVerification, state.agenticEnrollmentRequired],
  );

  return (
    <AppStateContext.Provider
      value={{
        state,
        setState,
        flow,
        logs,
        log,
        setLoading,
        setFlowFromEnrollment,
        completeStep,
        goToStep,
        reset,
        sessionRef,
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStepStatus(step: StepKey) {
  const { state, flow } = useAppState();
  const stepIdx = flow.indexOf(step);
  const activeIdx = flow.indexOf(state.activeStep);
  const done = state.completedSteps.has(step);
  const loading = state.loadingSteps.has(step);
  const active = state.activeStep === step;
  // A step is disabled while it's still ahead of the active step (and not already completed).
  const disabled = !done && activeIdx < stepIdx;
  // 1-based display number within the active flow.
  const num = stepIdx + 1;
  return { active, done, loading, disabled, num };
}
