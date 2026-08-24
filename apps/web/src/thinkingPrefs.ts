// Per-model reasoning-effort choices. These are a local UI preference rather
// than session state: selecting a model should restore its last effort across
// sessions and reloads, without creating a model-visible event.
import type { ModelRef } from "@polyth/contracts";

export const THINKING_PREFS_KEY = "polyth.thinkingPrefs.v1";

export type ThinkingPrefs = Record<string, string>;

export function thinkingModelKey(model: Pick<ModelRef, "providerID" | "modelID">): string {
  return `${model.providerID}/${model.modelID}`;
}

export function parseThinkingPrefs(raw: string | null): ThinkingPrefs {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const prefs: ThinkingPrefs = {};
    for (const [key, effort] of Object.entries(value)) {
      if (key && typeof effort === "string" && effort) prefs[key] = effort;
    }
    return prefs;
  } catch {
    return {};
  }
}

export function serializeThinkingPrefs(prefs: ThinkingPrefs): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(prefs).filter(([, effort]) => typeof effort === "string" && effort).sort(([a], [b]) => a.localeCompare(b)),
  ));
}

function read(): ThinkingPrefs {
  try { return parseThinkingPrefs(localStorage.getItem(THINKING_PREFS_KEY)); } catch { return {}; }
}

let prefs = read();

export function getModelThinking(model?: Pick<ModelRef, "providerID" | "modelID">): string | undefined {
  return model ? prefs[thinkingModelKey(model)] : undefined;
}

/** Save immediately on selection, including before the next message is sent. */
export function setModelThinking(
  model: Pick<ModelRef, "providerID" | "modelID">,
  effort: string | undefined,
): void {
  const key = thinkingModelKey(model);
  const next = { ...prefs };
  if (effort) next[key] = effort;
  else delete next[key];
  prefs = next;
  try {
    if (Object.keys(prefs).length === 0) localStorage.removeItem(THINKING_PREFS_KEY);
    else localStorage.setItem(THINKING_PREFS_KEY, serializeThinkingPrefs(prefs));
  } catch {
    // private mode / quota — selecting an effort must still work this turn
  }
}
