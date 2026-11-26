// The model and agent a new chat is created with.
import type { AgentDescriptor, HarnessSelection, ModelDescriptor, ModelRef } from "@polyth/contracts";

/**
 * A model or agent the caller chose is sent as chosen: the composer only
 * sends a row its own route catalogue lists. The aggregate catalogue cannot
 * judge it, because a per-person route such as a Relay lists its models only
 * in its own snapshot; filtering a choice against it dropped the pick and the
 * chat ran on the harness default ("Unknown"). Only an inherited default
 * (project or account) must be offered by the pinned harness, so a default
 * from another harness is never sent.
 */
export function creationModelAndAgent(input: {
  harness?: HarnessSelection;
  model?: ModelRef;
  agent?: string;
  defaultModel?: ModelRef;
  defaultAgent?: string;
  models: readonly ModelDescriptor[];
  agents: readonly AgentDescriptor[];
}): { model?: ModelRef; agent?: string } {
  const pinned = input.harness?.mode === "pinned" ? input.harness.harnessId : undefined;
  const model = input.model
    ?? (input.defaultModel && (!pinned || input.models.some((item) =>
      item.harnessId === pinned
      && item.providerID === input.defaultModel!.providerID
      && item.modelID === input.defaultModel!.modelID)) ? input.defaultModel : undefined);
  const agent = input.agent
    ?? (input.defaultAgent && (!pinned || input.agents.some((item) =>
      item.harnessId === pinned && item.name === input.defaultAgent)) ? input.defaultAgent : undefined);
  return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
}
