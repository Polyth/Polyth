// Hand-off from "Make agent" in a session menu to the Agents surface. The
// surface may not be mounted yet, so the seed waits here until it is taken.
import type { HarnessSelection } from "@polyth/contracts";
import type { ExecutionModel } from "./agentModel.ts";

export interface AgentSeed {
  projectId: string;
  sessionId: string;
  sessionTitle: string;
  model?: ExecutionModel;
  harness?: HarnessSelection;
}

let pending: AgentSeed | null = null;
const listeners = new Set<() => void>();

export function offerAgentSeed(seed: AgentSeed): void {
  pending = seed;
  for (const listener of listeners) listener();
}

export function takeAgentSeed(): AgentSeed | null {
  const seed = pending;
  pending = null;
  return seed;
}

export function onAgentSeed(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
