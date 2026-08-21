import { useSyncExternalStore } from "react";
import type { ModelRef } from "@polyth/contracts";

export const SESSION_DEFAULTS_KEY = "polyth.sessionDefaults";

export interface SessionDefaults {
  defaultModel?: ModelRef;
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
    const data = JSON.parse(raw ?? "") as { defaultModel?: unknown };
    const defaultModel = modelRef(data?.defaultModel);
    return defaultModel ? { defaultModel } : {};
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
  state = defaultModel ? { ...state, defaultModel } : { ...state, defaultModel: undefined };
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
