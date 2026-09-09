// UX-COMPOSER-DISC: one versioned browser-local record for the composer's
// pending execution configuration (preset / model / agent / thinking), keyed
// per account and canonical session with "" for the no-session hero composer.
// Explicit overrides clear presets so the visible Preset value never claims an
// unmodified bundle. The record survives reload and never crosses sessions or
// accounts; it is consumed after a send only when it still equals what was sent.
import type { ModelRef } from "@polyth/contracts";
import {
  accountStorageGet,
  accountStorageRemove,
  accountStorageSet,
} from "./accountStorage.ts";

type ComposerModelRef = ModelRef & { harnessId?: string };

/** `inherit`: no local choice — the session's stored preset (if any) applies.
 *  `none`: explicit None — the send clears the stored preset.
 *  `id`: an explicitly selected stored preset. */
export type ProfileChoice =
  | { kind: "inherit" }
  | { kind: "none" }
  | { kind: "id"; id: string };

export interface ComposerConfig {
  profile: ProfileChoice;
  model?: ComposerModelRef;
  agent?: string;
  /** A null value is an explicit Auto choice; undefined inherits defaults. */
  thinking?: string | null;
}

const KEY_PREFIX = "polyth.composer.config.v1.";
const keyOf = (sessionId: string | null | undefined): string => KEY_PREFIX + (sessionId ?? "");

export function emptyComposerConfig(): ComposerConfig {
  return { profile: { kind: "inherit" } };
}

export function isDefaultComposerConfig(cfg: ComposerConfig): boolean {
  return cfg.profile.kind === "inherit"
    && cfg.model === undefined
    && cfg.agent === undefined
    && cfg.thinking === undefined;
}

export function parseComposerConfig(raw: string | null): ComposerConfig {
  if (!raw) return emptyComposerConfig();
  try {
    const v = JSON.parse(raw) as {
      v?: unknown; profile?: unknown; model?: unknown; agent?: unknown; thinking?: unknown;
    };
    if (v.v !== 1) return emptyComposerConfig();
    const cfg = emptyComposerConfig();
    if (v.profile === "none") cfg.profile = { kind: "none" };
    else if (typeof v.profile === "string" && v.profile) cfg.profile = { kind: "id", id: v.profile };
    const m = v.model as { harnessId?: unknown; providerID?: unknown; modelID?: unknown } | undefined;
    if (m && typeof m.providerID === "string" && typeof m.modelID === "string") {
      cfg.model = {
        providerID: m.providerID,
        modelID: m.modelID,
        ...(typeof m.harnessId === "string" && m.harnessId ? { harnessId: m.harnessId } : {}),
      };
    }
    if (typeof v.agent === "string" && v.agent) cfg.agent = v.agent;
    if (v.thinking === null) cfg.thinking = null;
    else if (typeof v.thinking === "string" && v.thinking) cfg.thinking = v.thinking;
    return cfg;
  } catch {
    return emptyComposerConfig();
  }
}

export function serializeComposerConfig(cfg: ComposerConfig): string {
  return JSON.stringify({
    v: 1,
    profile: cfg.profile.kind === "id" ? cfg.profile.id : cfg.profile.kind === "none" ? "none" : null,
    ...(cfg.model ? { model: {
      providerID: cfg.model.providerID,
      modelID: cfg.model.modelID,
      ...(cfg.model.harnessId ? { harnessId: cfg.model.harnessId } : {}),
    } } : {}),
    ...(cfg.agent ? { agent: cfg.agent } : {}),
    ...(cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
  });
}

export function loadComposerConfig(sessionId: string | null | undefined): ComposerConfig {
  return parseComposerConfig(accountStorageGet(keyOf(sessionId)));
}

export function saveComposerConfig(sessionId: string | null | undefined, cfg: ComposerConfig): void {
  const key = keyOf(sessionId);
  if (isDefaultComposerConfig(cfg)) accountStorageRemove(key);
  else accountStorageSet(key, serializeComposerConfig(cfg));
}

// ------------------------------------------------------------- transitions

/** Selecting a preset clears explicit model and agent overrides. */
export function withProfile(cfg: ComposerConfig, id: string): ComposerConfig {
  void cfg;
  return { profile: { kind: "id", id } };
}

/** Explicit None clears only the preset selection; overrides survive. */
export function withProfileNone(cfg: ComposerConfig): ComposerConfig {
  return { ...cfg, profile: { kind: "none" } };
}

/** An explicit model clears the selected preset (the bundle no longer
 *  applies unmodified). Clearing the override (undefined) keeps the preset. */
export function withExplicitModel(cfg: ComposerConfig, model: ComposerModelRef | undefined): ComposerConfig {
  if (!model) {
    const next: ComposerConfig = { profile: cfg.profile };
    if (cfg.agent !== undefined) next.agent = cfg.agent;
    if (cfg.thinking !== undefined) next.thinking = cfg.thinking;
    return next;
  }
  const next: ComposerConfig = { profile: cfg.profile.kind === "id" ? { kind: "none" } : cfg.profile, model };
  if (cfg.agent !== undefined) next.agent = cfg.agent;
  if (cfg.thinking !== undefined) next.thinking = cfg.thinking;
  return next;
}

/** A pending effort belongs to the prior model. Model-specific saved effort
 * remains in thinkingPrefs and is re-derived when that model is selected. */
export function withModelForNextTurn(cfg: ComposerConfig, model: ComposerModelRef): ComposerConfig {
  return withExplicitThinking(withExplicitModel(cfg, model), undefined);
}

/** An explicit agent clears the selected preset, mirroring the model rule. */
export function withExplicitAgent(cfg: ComposerConfig, agent: string | undefined): ComposerConfig {
  const next: ComposerConfig = {
    profile: agent && cfg.profile.kind === "id" ? { kind: "none" } : cfg.profile,
  };
  if (cfg.model !== undefined) next.model = cfg.model;
  if (agent) next.agent = agent;
  if (cfg.thinking !== undefined) next.thinking = cfg.thinking;
  return next;
}

/** Thinking is an explicit per-turn override. Selecting it clears a preset
 * bundle because the bundle no longer applies unmodified. */
export function withExplicitThinking(cfg: ComposerConfig, thinking: string | undefined): ComposerConfig {
  const next: ComposerConfig = {
    profile: thinking && cfg.profile.kind === "id" ? { kind: "none" } : cfg.profile,
  };
  if (cfg.model !== undefined) next.model = cfg.model;
  if (cfg.agent !== undefined) next.agent = cfg.agent;
  if (thinking) next.thinking = thinking;
  return next;
}

/** Explicit Auto suppresses saved and session-level thinking fallbacks. */
export function withAutoThinking(cfg: ComposerConfig): ComposerConfig {
  return { ...cfg, thinking: null };
}

export function configEquals(a: ComposerConfig, b: ComposerConfig): boolean {
  return serializeComposerConfig(a) === serializeComposerConfig(b);
}

/** Wire value for the send request: string selects, null explicitly clears,
 *  undefined means omitted/inherited. The three are never conflated. */
export function wireProfileId(cfg: ComposerConfig): string | null | undefined {
  if (cfg.profile.kind === "id") return cfg.profile.id;
  if (cfg.profile.kind === "none") return null;
  return undefined;
}

/** After the authoritative send recorded the configuration, drop the local
 * pending record — but only when it still equals what was sent. */
export function consumeComposerConfig(sessionId: string | null | undefined, sent: ComposerConfig): void {
  const key = keyOf(sessionId);
  const current = parseComposerConfig(accountStorageGet(key));
  if (configEquals(current, sent)) accountStorageRemove(key);
}
