// UX-COMPOSER-DISC: one versioned browser-local record for the composer's
// pending execution configuration (profile / model / agent), keyed per
// canonical session with "" for the no-session hero composer. Profile and
// explicit overrides clear each other so the visible Profile value never
// claims an unmodified bundle. The record survives reload and never crosses
// sessions; it is consumed after a send only when it still equals what was
// sent.
import type { ModelRef } from "@polyth/contracts";

/** `inherit`: no local choice — the session's stored profile (if any) applies.
 *  `none`: explicit None — the send clears the stored profile.
 *  `id`: an explicitly selected stored profile. */
export type ProfileChoice =
  | { kind: "inherit" }
  | { kind: "none" }
  | { kind: "id"; id: string };

export interface ComposerConfig {
  profile: ProfileChoice;
  model?: ModelRef;
  agent?: string;
  thinking?: string;
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
    const m = v.model as { providerID?: unknown; modelID?: unknown } | undefined;
    if (m && typeof m.providerID === "string" && typeof m.modelID === "string") {
      cfg.model = { providerID: m.providerID, modelID: m.modelID };
    }
    if (typeof v.agent === "string" && v.agent) cfg.agent = v.agent;
    if (typeof v.thinking === "string" && v.thinking) cfg.thinking = v.thinking;
    return cfg;
  } catch {
    return emptyComposerConfig();
  }
}

export function serializeComposerConfig(cfg: ComposerConfig): string {
  return JSON.stringify({
    v: 1,
    profile: cfg.profile.kind === "id" ? cfg.profile.id : cfg.profile.kind === "none" ? "none" : null,
    ...(cfg.model ? { model: { providerID: cfg.model.providerID, modelID: cfg.model.modelID } } : {}),
    ...(cfg.agent ? { agent: cfg.agent } : {}),
    ...(cfg.thinking ? { thinking: cfg.thinking } : {}),
  });
}

export function loadComposerConfig(sessionId: string | null | undefined): ComposerConfig {
  try {
    return parseComposerConfig(localStorage.getItem(keyOf(sessionId)));
  } catch {
    return emptyComposerConfig();
  }
}

export function saveComposerConfig(sessionId: string | null | undefined, cfg: ComposerConfig): void {
  try {
    if (isDefaultComposerConfig(cfg)) localStorage.removeItem(keyOf(sessionId));
    else localStorage.setItem(keyOf(sessionId), serializeComposerConfig(cfg));
  } catch {
    // private mode / quota — pending configuration is best-effort like drafts
  }
}

// ------------------------------------------------------------- transitions

/** Selecting a profile clears explicit model and agent overrides. */
export function withProfile(cfg: ComposerConfig, id: string): ComposerConfig {
  void cfg;
  return { profile: { kind: "id", id } };
}

/** Explicit None clears only the profile selection; overrides survive. */
export function withProfileNone(cfg: ComposerConfig): ComposerConfig {
  return { ...cfg, profile: { kind: "none" } };
}

/** An explicit model clears the selected profile (the bundle no longer
 *  applies unmodified). Clearing the override (undefined) keeps the profile. */
export function withExplicitModel(cfg: ComposerConfig, model: ModelRef | undefined): ComposerConfig {
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

/** An explicit agent clears the selected profile, mirroring the model rule. */
export function withExplicitAgent(cfg: ComposerConfig, agent: string | undefined): ComposerConfig {
  const next: ComposerConfig = {
    profile: agent && cfg.profile.kind === "id" ? { kind: "none" } : cfg.profile,
  };
  if (cfg.model !== undefined) next.model = cfg.model;
  if (agent) next.agent = agent;
  if (cfg.thinking !== undefined) next.thinking = cfg.thinking;
  return next;
}

/** Thinking is an explicit per-turn override. Selecting it clears a profile
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
 *  pending record — but only when it still equals what was sent. */
export function consumeComposerConfig(sessionId: string | null | undefined, sent: ComposerConfig): void {
  try {
    const current = parseComposerConfig(localStorage.getItem(keyOf(sessionId)));
    if (configEquals(current, sent)) localStorage.removeItem(keyOf(sessionId));
  } catch {
    // best-effort
  }
}
