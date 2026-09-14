import { useSyncExternalStore } from "react";
import type { ModelRef, ProjectDefaults } from "@polyth/contracts";

export const SESSION_DEFAULTS_KEY = "polyth.sessionDefaults";

type StoredModelRef = ModelRef & { harnessId?: string };

export interface SessionDefaults {
  defaultModel?: StoredModelRef;
  defaultThinking?: string;
  defaultAgent?: string;
  smallModel?: StoredModelRef;
  walkthroughModel?: StoredModelRef;
  retentionDays?: number;
  retentionAction?: "archive" | "delete";
  archiveRetentionDays?: number;
}

function modelRef(value: unknown): StoredModelRef | undefined {
  const candidate = value as (Partial<ModelRef> & { harnessId?: unknown }) | undefined;
  return typeof candidate?.providerID === "string" && candidate.providerID
    && typeof candidate.modelID === "string" && candidate.modelID
    ? {
        providerID: candidate.providerID,
        modelID: candidate.modelID,
        ...(typeof candidate.harnessId === "string" && candidate.harnessId
          ? { harnessId: candidate.harnessId }
          : {}),
      }
    : undefined;
}

export function parseSessionDefaults(raw: string | null): SessionDefaults {
  try {
    const data = JSON.parse(raw ?? "") as Record<string, unknown>;
    const defaultModel = modelRef(data?.defaultModel);
    const smallModel = modelRef(data?.smallModel);
    const walkthroughModel = modelRef(data?.walkthroughModel);
    const defaultThinking = typeof data?.defaultThinking === "string" && data.defaultThinking
      ? data.defaultThinking
      : undefined;
    const defaultAgent = typeof data?.defaultAgent === "string" && data.defaultAgent
      ? data.defaultAgent
      : undefined;
    const retentionDays = typeof data?.retentionDays === "number" && Number.isFinite(data.retentionDays)
      ? Math.min(3650, Math.max(1, Math.round(data.retentionDays)))
      : undefined;
    const archiveRetentionDays = typeof data?.archiveRetentionDays === "number" && Number.isFinite(data.archiveRetentionDays)
      ? Math.min(3650, Math.max(1, Math.round(data.archiveRetentionDays)))
      : undefined;
    const retentionAction = data?.retentionAction === "archive" || data?.retentionAction === "delete"
      ? data.retentionAction
      : undefined;
    return {
      ...(defaultModel ? { defaultModel } : {}),
      ...(defaultThinking ? { defaultThinking } : {}),
      ...(defaultAgent ? { defaultAgent } : {}),
      ...(smallModel ? { smallModel } : {}),
      ...(walkthroughModel ? { walkthroughModel } : {}),
      ...(retentionDays ? { retentionDays } : {}),
      ...(retentionAction ? { retentionAction } : {}),
      ...(archiveRetentionDays ? { archiveRetentionDays } : {}),
    };
  } catch {
    return {};
  }
}

export function resolveSessionDefaultModel(
  projectDefault?: StoredModelRef | null,
  globalDefault?: StoredModelRef,
  availableFallback?: StoredModelRef,
): StoredModelRef | undefined {
  return projectDefault || globalDefault || availableFallback;
}

/** Existing project defaults predate the toggle, so a stored model implies
 * enabled memory until the user explicitly turns it off. */
export function projectRemembersModelSelection(defaults?: ProjectDefaults): boolean {
  return defaults?.rememberModelSelection ?? defaults?.model != null;
}

export function resolveProjectModelDefault(
  defaults?: ProjectDefaults,
  globalDefault?: StoredModelRef,
  availableFallback?: StoredModelRef,
): StoredModelRef | undefined {
  return resolveSessionDefaultModel(
    projectRemembersModelSelection(defaults) ? defaults?.model : null,
    globalDefault,
    availableFallback,
  );
}

function read(): SessionDefaults {
  try {
    const stored = localStorage.getItem(SESSION_DEFAULTS_KEY);
    if (stored !== null) return parseSessionDefaults(stored);
    // One-way compatibility with the older global string setting.
    const legacy = JSON.parse(localStorage.getItem("polyth.settings") ?? "{}") as { defaultModel?: unknown };
    if (typeof legacy.defaultModel === "string") {
      const slash = legacy.defaultModel.indexOf("/");
      if (slash > 0 && slash < legacy.defaultModel.length - 1) {
        return {
          defaultModel: {
            providerID: legacy.defaultModel.slice(0, slash),
            modelID: legacy.defaultModel.slice(slash + 1),
          },
        };
      }
    }
  } catch {
    // storage unavailable
  }
  return {};
}

let state = read();
const listeners = new Set<() => void>();

export function getSessionDefaults(): SessionDefaults {
  return state;
}

export function setGlobalDefaultModel(defaultModel?: StoredModelRef): void {
  setSessionDefaults({ defaultModel });
}

export function setSessionDefaults(patch: Partial<SessionDefaults>): void {
  state = { ...state, ...patch };
  try { localStorage.setItem(SESSION_DEFAULTS_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
}

/** Subscribe to any change in the local session-defaults record. Returns an
 *  unsubscribe fn. Used by settings sync to mirror the record to the server. */
export function subscribeSessionDefaults(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSessionDefaults(): SessionDefaults {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSessionDefaults,
  );
}
