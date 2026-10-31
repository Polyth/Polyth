// Per-model reasoning-effort choices. The local record is a synchronous cache
// for the account settings sync rather than session state: selecting a model
// restores its last effort across sessions, reloads, and clients.
import { useSyncExternalStore } from "react";
import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { resolveVariantPreference } from "@polyth/contracts";
import {
  accountStorageGet,
  accountStorageKey,
  accountStorageRemove,
  accountStorageSet,
} from "@polyth/web/account-storage";

export const THINKING_PREFS_KEY = "polyth.thinkingPrefs.v2";

/** An empty string records explicit Auto; an absent key is untouched. */
export type ThinkingPrefs = Record<string, string>;

type ThinkingModelRef = Pick<ModelRef, "providerID" | "modelID"> & { harnessId?: string };

export function thinkingModelKey(model: ThinkingModelRef): string {
  return `${model.harnessId ?? "local"}/${model.providerID}/${model.modelID}`;
}

/**
 * The one place the composer decides which reasoning variant a turn carries.
 * `configThinking` is `null` for an explicit Auto — a real user choice that
 * the backend default must not override — and `undefined` when untouched. An
 * untouched control first restores what the session itself recorded on its
 * model (`recordedThinking`, `null` when that turn ran on the model's own
 * default), so reopening a chat shows the effort it actually used rather than
 * the last effort chosen for that model elsewhere. Only then do the saved
 * preference (including Auto), the session default and the model's own
 * default variant apply. A remembered variant the selected model does not
 * advertise is reconciled instead of sent or silently dropped.
 */
export function resolveComposerThinking(input: {
  descriptor?: Pick<ModelDescriptor, "variants" | "defaultVariant">;
  configThinking: string | null | undefined;
  /** The variant recorded on the session's own model; `null` = no explicit
   *  variant was recorded and that chat used the model's default. Only pass
   *  this when the selected model is the session's recorded model. */
  recordedThinking?: string | null;
  savedThinking?: string;
  sessionDefault?: string;
}): { variant?: string; reconciled: boolean } {
  const choice = composerThinkingChoice(input);
  const requested = choice === undefined ? input.sessionDefault : choice;
  if (requested === null) return { reconciled: false };
  return resolveVariantPreference(input.descriptor, requested ?? undefined);
}

/** The explicit effort the controlled picker shows: a pending composer choice,
 *  then the session's own record (including recorded Auto), then this model's
 *  saved preference. `undefined` means no explicit choice — inherit the session
 *  or model default instead of displaying it as selected. */
export function composerThinkingChoice(input: {
  configThinking: string | null | undefined;
  recordedThinking?: string | null;
  savedThinking?: string;
}): string | null | undefined {
  if (input.configThinking !== undefined) return input.configThinking;
  if (input.recordedThinking !== undefined) return input.recordedThinking;
  return input.savedThinking === "" ? null : input.savedThinking;
}

export function parseThinkingPrefs(raw: string | null): ThinkingPrefs {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const prefs: ThinkingPrefs = {};
    for (const [key, effort] of Object.entries(value)) {
      if (key && typeof effort === "string") prefs[key] = effort;
    }
    return prefs;
  } catch {
    return {};
  }
}

export function serializeThinkingPrefs(prefs: ThinkingPrefs): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(prefs).filter(([key, effort]) => key && typeof effort === "string").sort(([a], [b]) => a.localeCompare(b)),
  ));
}

let prefs = parseThinkingPrefs(accountStorageGet(THINKING_PREFS_KEY));
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== accountStorageKey(THINKING_PREFS_KEY)) return;
    prefs = parseThinkingPrefs(event.newValue);
    emit();
  });
}

export function getModelThinking(model?: ThinkingModelRef): string | undefined {
  return model ? prefs[thinkingModelKey(model)] : undefined;
}

/** The effort a session recorded on its own model, or `undefined` when the
 *  selection is some other model and that record does not apply. A session
 *  model with no variant recorded returns `null`: that chat ran on the model's
 *  default, which must not be replaced by a later pick for the same model
 *  elsewhere. An unqualified legacy session belongs to OpenCode, as in the
 *  picker, so a harness-qualified selection is compared against that default. */
export function recordedSessionThinking(
  selected: ThinkingModelRef | undefined,
  sessionModel: (ThinkingModelRef & { variant?: string }) | undefined,
  /** The route that ran the session's model; projection refs do not carry it. */
  sessionHarnessId?: string,
): string | null | undefined {
  if (!selected || !sessionModel) return undefined;
  if (selected.providerID !== sessionModel.providerID || selected.modelID !== sessionModel.modelID) return undefined;
  const sessionHarness = sessionModel.harnessId ?? sessionHarnessId ?? "opencode";
  if (selected.harnessId && selected.harnessId !== sessionHarness) return undefined;
  return sessionModel.variant ?? null;
}

/** Save immediately on selection, including before the next message is sent. */
export function replaceThinkingPrefs(value: unknown): void {
  prefs = parseThinkingPrefs(JSON.stringify(value));
  if (Object.keys(prefs).length === 0) accountStorageRemove(THINKING_PREFS_KEY);
  else accountStorageSet(THINKING_PREFS_KEY, serializeThinkingPrefs(prefs));
  emit();
}

export function getThinkingPrefs(): ThinkingPrefs {
  return prefs;
}

export function subscribeThinkingPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useThinkingPrefs(): ThinkingPrefs {
  return useSyncExternalStore(subscribeThinkingPrefs, getThinkingPrefs);
}

export function useModelThinking(model?: ThinkingModelRef): string | undefined {
  const snapshot = useThinkingPrefs();
  return model ? snapshot[thinkingModelKey(model)] : undefined;
}

/** Empty string selects Auto; undefined clears a stale preference. */
export function setModelThinking(
  model: ThinkingModelRef,
  effort: string | undefined,
): void {
  const key = thinkingModelKey(model);
  if (prefs[key] === effort) return;
  const next = { ...prefs };
  if (effort !== undefined) next[key] = effort;
  else delete next[key];
  prefs = next;
  if (Object.keys(prefs).length === 0) accountStorageRemove(THINKING_PREFS_KEY);
  else accountStorageSet(THINKING_PREFS_KEY, serializeThinkingPrefs(prefs));
  emit();
}
