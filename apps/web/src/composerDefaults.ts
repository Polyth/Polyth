import type { AgentDescriptor, ModelDescriptor } from "@polyth/contracts";
import { tr } from "./i18n/index.ts";

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
  if (!resolved) return tr("composerDefaults.noModel");
  const descriptor = models.find(
    (model) => model.providerID === resolved.providerID && model.modelID === resolved.modelID,
  );
  const name = descriptor?.name || resolved.modelID;
  return sessionModel ? name : tr("composerDefaults.defaultValue", { value: name });
}

export function agentPickerDefaultLabel(
  sessionAgent: string | null | undefined,
  agents: readonly AgentDescriptor[],
): string {
  if (sessionAgent) return sessionAgent;
  return agents[0]
    ? tr("composerDefaults.defaultValue", { value: agents[0].name })
    : tr("composerDefaults.noAgent");
}
