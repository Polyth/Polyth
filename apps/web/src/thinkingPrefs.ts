// Per-model reasoning-effort choices. These are a browser-local account
// preference rather than session state: selecting a model restores its last
// effort across sessions and reloads without crossing account boundaries.
import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { resolveVariantPreference } from "@polyth/contracts";
import {
  accountStorageGet,
  accountStorageRemove,
  accountStorageSet,
} from "./accountStorage.ts";

export const THINKING_PREFS_KEY = "polyth.thinkingPrefs.v2";

export type ThinkingPrefs = Record<string, string>;

type ThinkingModelRef = Pick<ModelRef, "providerID" | "modelID"> & { harnessId?: string };

export function thinkingModelKey(model: ThinkingModelRef): string {
  return `${model.harnessId ?? "local"}/${model.providerID}/${model.modelID}`;
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

let prefs = parseThinkingPrefs(accountStorageGet(THINKING_PREFS_KEY));

export function getModelThinking(model?: ThinkingModelRef): string | undefined {
  return model ? prefs[thinkingModelKey(model)] : undefined;
}

/** Save immediately on selection, including before the next message is sent. */
export function setModelThinking(
  model: ThinkingModelRef,
  effort: string | undefined,
): void {
  const key = thinkingModelKey(model);
  const next = { ...prefs };
  if (effort) next[key] = effort;
  else delete next[key];
  prefs = next;
  if (Object.keys(prefs).length === 0) accountStorageRemove(THINKING_PREFS_KEY);
  else accountStorageSet(THINKING_PREFS_KEY, serializeThinkingPrefs(prefs));
}
