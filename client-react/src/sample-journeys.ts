import type { AppConfig } from "./api.ts";
import { type Network } from "./flow.ts";

export function isEuropeSample(search: string): boolean {
  return new URLSearchParams(search).get("flow") === "visa-v2-europe";
}

export interface MockScenario {
  scenario: string;
  network: Network;
  vaultId: string;
  browserSupported: boolean;
  description: string;
}

export function fixtureScenarios(config: AppConfig, network: Network, europe = false): MockScenario[] {
  return (config.mockScenarios ?? []).filter((fixture) => fixture.network === network
    && fixture.scenario.startsWith("eu-") === europe);
}

export async function activateMockScenario(config: AppConfig, scenario: string): Promise<void> {
  if (config.mockMode !== "vic-v2-europe" || !config.mockScenarios?.some((fixture) => fixture.scenario === scenario)) {
    throw new Error("Select an available local fixture profile.");
  }
  const response = await fetch("/api/mock/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario }) });
  if (!response.ok) throw new Error("The local provider fixture could not be activated.");
}
