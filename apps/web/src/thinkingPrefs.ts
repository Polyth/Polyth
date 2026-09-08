// Per-model reasoning-effort choices. These are a local UI preference rather
// than session state: selecting a model should restore its last effort across
// sessions and reloads, without creating a model-visible event.
import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { resolveVariantPreference } from "@polyth/contracts";

export const THINKING_PREFS_KEY = "polyth.thinkingPrefs.v1";

export type ThinkingPrefs = Record<string, string>;

export function thinkingModelKey(model: Pick<ModelRef, "providerID" | "modelID">): string {
  return `${model.providerID}/${model.modelID}`;
}

/**
 * The one place the composer decides which reasoning variant a turn carries.
 * `configThinking` is `null` for an explicit Auto — a real user choice that
 * the backend default must not override — and `undefined` when untouched, in
 * which case the saved preference, then the session default, then the model's
 * own default variant apply. A remembered variant the selected model does not
 * advertise is reconciled instead of sent or silently dropped.
 */
export function resolveComposerThinking(input: {
  descriptor?: Pick<ModelDescriptor, "variants" | "defaultVariant">;
  configThinking: string | null | undefined;
  savedThinking?: string;
  sessionDefault?: string;
}): { variant?: string; reconciled: boolean } {
  const requested = input.configThinking !== undefined
    ? input.configThinking
    : input.savedThinking ?? input.sessionDefault;
  if (requested === null) return { reconciled: false };
  return resolveVariantPreference(input.descriptor, requested ?? undefined);
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
