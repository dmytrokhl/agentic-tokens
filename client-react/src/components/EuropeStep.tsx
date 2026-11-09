import { useState, type ReactNode } from "react";
import { StepPanel } from "./StepPanel";

export interface EuropeNavigation {
  activeStep: number;
  goToStep: (step: number) => void;
  log: (message: string) => void;
}

export function EuropeStep({ number, title, navigation, enabled = true, done = false, loading = false, response, children }: {
  number: number; title: string; navigation: EuropeNavigation; enabled?: boolean;
  done?: boolean; loading?: boolean; response?: unknown; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const active = navigation.activeStep === number;
  return <StepPanel title={title} num={number} open={active && !collapsed} active={active} done={done}
    loading={loading} disabled={!enabled && !active} response={response} keepMounted onHeaderClick={() => {
      if (!enabled) return;
      if (active) setCollapsed((value) => !value);
      else { setCollapsed(false); navigation.goToStep(number); }
    }}>{children}</StepPanel>;
}
