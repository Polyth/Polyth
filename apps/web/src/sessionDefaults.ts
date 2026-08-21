import { useSyncExternalStore } from "react";
import type { ModelRef } from "@polyth/contracts";

export const SESSION_DEFAULTS_KEY = "polyth.sessionDefaults";

export interface SessionDefaults {
  defaultModel?: ModelRef;
  defaultThinking?: string;
  defaultAgent?: string;
  smallModel?: ModelRef;
  walkthroughModel?: ModelRef;
  retentionDays?: number;
  retentionAction?: "archive";
}

function modelRef(value: unknown): ModelRef | undefined {
  const candidate = value as Partial<ModelRef> | undefined;
  return typeof candidate?.providerID === "string" && candidate.providerID
    && typeof candidate.modelID === "string" && candidate.modelID
    ? { providerID: candidate.providerID, modelID: candidate.modelID }
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
    return {
      ...(defaultModel ? { defaultModel } : {}),
      ...(defaultThinking ? { defaultThinking } : {}),
      ...(defaultAgent ? { defaultAgent } : {}),
      ...(smallModel ? { smallModel } : {}),
      ...(walkthroughModel ? { walkthroughModel } : {}),
      ...(retentionDays ? { retentionDays } : {}),
      ...(data?.retentionAction === "archive" ? { retentionAction: "archive" as const } : {}),
    };
  } catch {
    return {};
  }
}

export function resolveSessionDefaultModel(
  projectDefault?: ModelRef | null,
  globalDefault?: ModelRef,
): ModelRef | undefined {
  return projectDefault || globalDefault;
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

export function setGlobalDefaultModel(defaultModel?: ModelRef): void {
  setSessionDefaults({ defaultModel });
}

export function setSessionDefaults(patch: Partial<SessionDefaults>): void {
  state = { ...state, ...patch };
  try { localStorage.setItem(SESSION_DEFAULTS_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
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
