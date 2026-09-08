import type { DraftExecutionConfig, HarnessSelection } from "@polyth/contracts";

const PREFIX = "polyth.executionDraft.v1.";
const listeners = new Set<() => void>();

const validSelection = (value: unknown): HarnessSelection => {
  if (value && typeof value === "object") {
    const input = value as { mode?: unknown; harnessId?: unknown };
    if (input.mode === "pinned" && typeof input.harnessId === "string" && /^[a-z][a-z0-9-]*$/.test(input.harnessId)) {
      return { mode: "pinned", harnessId: input.harnessId };
    }
  }
  return { mode: "auto" };
};

export function emptyDraftExecutionConfig(): DraftExecutionConfig {
  return { harnessSelection: { mode: "auto" } };
}

export function readDraftExecutionConfig(projectId: string): DraftExecutionConfig {
  try {
    const input = JSON.parse(localStorage.getItem(PREFIX + projectId) ?? "null") as Record<string, unknown> | null;
    if (!input) return emptyDraftExecutionConfig();
    const model = input.model as { harnessId?: unknown; providerID?: unknown; modelID?: unknown; variant?: unknown } | undefined;
    const agent = input.agent as { harnessId?: unknown; agent?: unknown } | undefined;
    return {
      harnessSelection: validSelection(input.harnessSelection),
      ...(input.harnessSelectionExplicit === true ? { harnessSelectionExplicit: true } : {}),
      ...(model && typeof model.harnessId === "string" && typeof model.providerID === "string" && typeof model.modelID === "string"
        ? { model: {
            harnessId: model.harnessId,
            providerID: model.providerID,
            modelID: model.modelID,
            ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
          } }
        : {}),
      ...(typeof input.profileId === "string" ? { profileId: input.profileId } : {}),
      ...(agent && typeof agent.harnessId === "string" && typeof agent.agent === "string"
        ? { agent: { harnessId: agent.harnessId, agent: agent.agent } }
        : {}),
      ...(typeof input.thinking === "string" ? { thinking: input.thinking } : {}),
      ...(typeof input.mode === "string" ? { mode: input.mode } : {}),
      ...(input.features && typeof input.features === "object"
        ? { features: Object.fromEntries(Object.entries(input.features as Record<string, unknown>)
            .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) }
        : {}),
    };
  } catch {
    return emptyDraftExecutionConfig();
  }
}

export function writeDraftExecutionConfig(projectId: string, config: DraftExecutionConfig): void {
  try {
    const empty = config.harnessSelection.mode === "auto"
      && !config.harnessSelectionExplicit
      && !config.model && !config.profileId && !config.agent && !config.thinking && !config.mode
      && !Object.keys(config.features ?? {}).length;
    if (empty) localStorage.removeItem(PREFIX + projectId);
    else localStorage.setItem(PREFIX + projectId, JSON.stringify(config));
  } catch {
    // Browser-local draft state is best-effort, like the prompt draft.
  }
  for (const listener of [...listeners]) listener();
}

export function updateDraftExecutionConfig(projectId: string, patch: Partial<DraftExecutionConfig>): DraftExecutionConfig {
  const next = { ...readDraftExecutionConfig(projectId), ...patch };
  writeDraftExecutionConfig(projectId, next);
  return next;
}

export function clearDraftExecutionConfig(projectId: string): void {
  try { localStorage.removeItem(PREFIX + projectId); } catch { /* best effort */ }
  for (const listener of [...listeners]) listener();
}

export function subscribeDraftExecutionConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
