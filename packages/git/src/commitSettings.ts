import type { ModelRef } from "@polyth/contracts";

export interface CommitSettings {
  mode: "session" | "small" | "custom";
  model?: ModelRef & { harnessId: string };
}

export function parseCommitSettings(value: unknown): CommitSettings {
  const input = value as Partial<CommitSettings> | null;
  if (!input || !["session", "small", "custom"].includes(input.mode ?? "")) {
    throw Object.assign(new Error("Choose a commit message model"), { code: "invalid-input" });
  }
  if (input.mode !== "custom") return { mode: input.mode! };
  const model = input.model;
  if (!model || ![model.harnessId, model.providerID, model.modelID].every((id) => typeof id === "string" && id.trim().length > 0)) {
    throw Object.assign(new Error("Choose a custom model and harness"), { code: "invalid-input" });
  }
  return { mode: "custom", model: { harnessId: model.harnessId, providerID: model.providerID, modelID: model.modelID, ...(typeof model.variant === "string" && model.variant ? { variant: model.variant } : {}) } };
}
