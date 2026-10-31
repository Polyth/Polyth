import type { DraftExecutionConfig, HarnessSelection } from "@polyth/contracts";
import {
  accountStorageGet,
  accountStorageRemove,
  accountStorageSet,
} from "./accountStorage.ts";

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

/** A new chat's route without the harnesses the caller cannot use. A hidden
 *  remembered pick (harness tab, model or agent) reads as nothing chosen and
 *  a hidden project default as no default; `hidden` says one was dropped.
 *  `visible` is the caller's roster, undefined while unknown (keep all). */
export function newChatDraftRoute(
  draft: DraftExecutionConfig,
  projectHarness: HarnessSelection | null | undefined,
  visible: ReadonlySet<string> | undefined,
): { draft: DraftExecutionConfig; projectHarness?: HarnessSelection; hidden: boolean } {
  const hiddenId = (harnessId: string | undefined) => !!visible && harnessId !== undefined && !visible.has(harnessId);
  const pinHidden = draft.harnessSelection.mode === "pinned" && hiddenId(draft.harnessSelection.harnessId);
  const modelHidden = hiddenId(draft.model?.harnessId);
  const agentHidden = hiddenId(draft.agent?.harnessId);
  const projectHidden = projectHarness?.mode === "pinned" && hiddenId(projectHarness.harnessId);
  if (!pinHidden && !modelHidden && !agentHidden && !projectHidden) {
    return { draft, ...(projectHarness ? { projectHarness } : {}), hidden: false };
  }
  const { model, agent, harnessSelectionExplicit, ...rest } = draft;
  return {
    draft: {
      ...rest,
      harnessSelection: pinHidden ? { mode: "auto" } : draft.harnessSelection,
      ...(harnessSelectionExplicit && !pinHidden ? { harnessSelectionExplicit } : {}),
      ...(model && !modelHidden ? { model } : {}),
      ...(agent && !agentHidden ? { agent } : {}),
    },
    ...(projectHarness && !projectHidden ? { projectHarness } : {}),
    hidden: true,
  };
}

/** The harness of the first favorite, then most recent, model key
 *  (`harness::provider/model`) the caller may use; undefined leaves the server
 *  to pick the first available one. */
export function preferredVisibleHarness(
  prefs: { favorites: readonly string[]; recents: readonly string[] },
  visible: ReadonlySet<string> | undefined,
): string | undefined {
  if (!visible) return undefined;
  for (const key of [...prefs.favorites, ...prefs.recents]) {
    const harnessId = key.includes("::") ? key.slice(0, key.indexOf("::")) : undefined;
    if (harnessId && visible.has(harnessId)) return harnessId;
  }
  return undefined;
}

export function readDraftExecutionConfig(projectId: string): DraftExecutionConfig {
  try {
    const input = JSON.parse(accountStorageGet(PREFIX + projectId) ?? "null") as Record<string, unknown> | null;
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
  const key = PREFIX + projectId;
  const empty = config.harnessSelection.mode === "auto"
    && !config.harnessSelectionExplicit
    && !config.model && !config.profileId && !config.agent && !config.thinking && !config.mode
    && !Object.keys(config.features ?? {}).length;
  if (empty) accountStorageRemove(key);
  else accountStorageSet(key, JSON.stringify(config));
  for (const listener of [...listeners]) listener();
}

export function updateDraftExecutionConfig(projectId: string, patch: Partial<DraftExecutionConfig>): DraftExecutionConfig {
  const next = { ...readDraftExecutionConfig(projectId), ...patch };
  writeDraftExecutionConfig(projectId, next);
  return next;
}

export function clearDraftExecutionConfig(projectId: string): void {
  accountStorageRemove(PREFIX + projectId);
  for (const listener of [...listeners]) listener();
}

export function subscribeDraftExecutionConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
