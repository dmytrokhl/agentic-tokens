import { StepPanel } from "./StepPanel";
import { type ReactNode, useState } from "react";
import { useAppState, useStepStatus, type StepKey } from "../useAppState";

interface StepProps {
  stepKey: StepKey;
  title: string;
  children: ReactNode;
  response?: unknown;
  responseMeta?: string | null;
  manual?: boolean;
}

export function Step({ stepKey, title, children, response, responseMeta, manual = false }: StepProps) {
  const { goToStep } = useAppState();
  const { active, done, loading, disabled, num } = useStepStatus(stepKey);
  const [collapsed, setCollapsed] = useState(false);
  const [manuallyOpen, setManuallyOpen] = useState(false);
  const open = manual ? manuallyOpen : active && !collapsed;

  function handleHeaderClick() {
    if (manual) {
      setManuallyOpen((value) => !value);
    } else if (active) {
      setCollapsed((c) => !c);
    } else {
      goToStep(stepKey);
    }
  }

  return <StepPanel title={title} response={response} responseMeta={responseMeta} open={open}
    done={done} loading={loading} active={active} disabled={disabled && !manual} num={num}
    manual={manual} onHeaderClick={handleHeaderClick}>{children}</StepPanel>;
}
