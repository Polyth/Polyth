import type { AgentDescriptor, ModelDescriptor } from "@polyth/contracts";

interface ModelRef {
  providerID: string;
  modelID: string;
}

export function modelPickerDefaultLabel(
  sessionModel: ModelRef | null | undefined,
  models: readonly ModelDescriptor[],
  preferredModel?: ModelRef,
): string {
  const resolved = sessionModel ?? preferredModel ?? models[0];
  if (!resolved) return "No model";
  const descriptor = models.find(
    (model) => model.providerID === resolved.providerID && model.modelID === resolved.modelID,
  );
  const name = descriptor?.name || resolved.modelID;
  return sessionModel ? name : `Default: ${name}`;
}

export function agentPickerDefaultLabel(
  sessionAgent: string | null | undefined,
  agents: readonly AgentDescriptor[],
): string {
  if (sessionAgent) return sessionAgent;
  return agents[0] ? `Default: ${agents[0].name}` : "No agent";
}
