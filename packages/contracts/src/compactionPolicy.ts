// When a long conversation is compacted ("Chat memory" in the UI). Browser-safe:
// the server decides with these rules and the card draws the same numbers.
//
// `auto` leaves the harness's own automatic compaction alone and costs nothing.
// `earlier` and `custom` compact before the next message once the conversation
// passes a share of the model's window, on every harness, through the ordinary
// compaction path. `manual` turns the harness's own compaction off where
// `RuntimeCapabilities.autoCompactionSwitch` says it can be.

export const COMPACTION_MODES = ["auto", "earlier", "custom", "manual"] as const;
export type CompactionMode = (typeof COMPACTION_MODES)[number];

export interface CompactionPreference {
  mode: CompactionMode;
  /** Share of the window in percent; meaningful only for `custom`. */
  percent?: number;
}

export const COMPACTION_AUTO: CompactionPreference = { mode: "auto" };
export const COMPACTION_EARLIER_PERCENT = 60;
export const COMPACTION_CUSTOM_MIN_PERCENT = 40;
export const COMPACTION_CUSTOM_MAX_PERCENT = 95;
export const COMPACTION_CUSTOM_STEP_PERCENT = 5;
/** `manual` asks the person to compact from here on. Early on purpose: with its
 *  own compaction off Claude Code refuses every message from about 88% of a 200k
 *  window, and one large result can cross several points at once. */
export const COMPACTION_REMINDER_PERCENT = 75;

/** Room kept free so the agent can still write its summary: a tenth of the
 *  window, so a small model does not compact constantly and a large one does
 *  not hold back a fixed share it never needs. */
const RESERVE_SHARE = 0.1;
export const COMPACTION_RESERVE_MIN_TOKENS = 4_000;
export const COMPACTION_RESERVE_MAX_TOKENS = 50_000;

/** The stored shape of a preference, or undefined for anything else. A custom
 *  share snaps to the steps the slider offers. */
export function parseCompactionPreference(value: unknown): CompactionPreference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { mode, percent } = value as { mode?: unknown; percent?: unknown };
  if (mode === "auto" || mode === "earlier" || mode === "manual") return { mode };
  if (mode !== "custom" || typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  const stepped = Math.round(percent / COMPACTION_CUSTOM_STEP_PERCENT) * COMPACTION_CUSTOM_STEP_PERCENT;
  return {
    mode,
    percent: Math.min(COMPACTION_CUSTOM_MAX_PERCENT, Math.max(COMPACTION_CUSTOM_MIN_PERCENT, stepped)),
  };
}

export function compactionReserveTokens(windowTokens: number): number {
  return Math.min(
    COMPACTION_RESERVE_MAX_TOKENS,
    Math.max(COMPACTION_RESERVE_MIN_TOKENS, Math.round(windowTokens * RESERVE_SHARE)),
  );
}

/** The fullest a conversation may get and still leave room for its summary. */
export function compactionLatestTokens(windowTokens: number): number | undefined {
  if (!Number.isFinite(windowTokens) || windowTokens <= COMPACTION_RESERVE_MIN_TOKENS) return undefined;
  return windowTokens - compactionReserveTokens(windowTokens);
}

/** The share Polyth itself compacts at, or undefined when it leaves that to
 *  the harness (`auto`) or the person (`manual`). */
export function compactionTargetPercent(preference: CompactionPreference): number | undefined {
  if (preference.mode === "earlier") return COMPACTION_EARLIER_PERCENT;
  return preference.mode === "custom" ? preference.percent : undefined;
}

/** Whether this conversation should be compacted before its next message.
 *  An unmeasured window never compacts: the summary is a paid request and
 *  nothing says it is needed. */
export function compactionDue(
  preference: CompactionPreference,
  window: { usedTokens?: number | undefined; limitTokens?: number | undefined; fraction?: number | undefined },
): boolean {
  const percent = compactionTargetPercent(preference);
  if (percent === undefined) return false;
  const { usedTokens, limitTokens, fraction } = window;
  if (usedTokens !== undefined && limitTokens !== undefined && limitTokens > 0) {
    const latest = compactionLatestTokens(limitTokens);
    if (latest === undefined) return false;
    return usedTokens >= Math.min(limitTokens * (percent / 100), latest);
  }
  return typeof fraction === "number" && Number.isFinite(fraction) && fraction >= percent / 100;
}

/** Whichever choice applies: the chat's own, else the person's default. */
export function effectiveCompactionPreference(
  chat: CompactionPreference | undefined,
  personDefault: CompactionPreference | undefined,
): CompactionPreference {
  return chat ?? personDefault ?? COMPACTION_AUTO;
}

/** `manual` needs a harness that can turn its own compaction off; elsewhere the
 *  harness keeps compacting, so saying "manual" would be untrue. */
export function supportedCompactionPreference(
  preference: CompactionPreference,
  canSwitchOffAutoCompaction: boolean,
): CompactionPreference {
  return preference.mode === "manual" && !canSwitchOffAutoCompaction ? COMPACTION_AUTO : preference;
}

/** Marks the share of the window where Polyth itself will compact. `auto` has no
 *  mark on purpose: nothing a harness reports says when it really compacts (Claude
 *  Code reports 83.5% of a 200k window and compacts when the next message no longer
 *  fits), so a number there would be a promise nobody keeps. */
export function compactionMarkPercent(
  preference: CompactionPreference,
  window: { limitTokens?: number | undefined },
): number | undefined {
  const target = compactionTargetPercent(preference);
  if (target === undefined) return undefined;
  const limit = window.limitTokens;
  const latest = limit ? compactionLatestTokens(limit) : undefined;
  return limit && latest !== undefined ? Math.min(target, (latest / limit) * 100) : target;
}
