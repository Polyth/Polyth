// Which "Chat memory" choice applies to a chat, for the card and the reminder.
// The server decides with the same rules (`compactionPreferenceOf`) from the
// acting person's default; in a shared chat that person may be someone else.
import {
  COMPACTION_REMINDER_PERCENT,
  compactionLatestTokens,
  effectiveCompactionPreference,
  supportedCompactionPreference,
  type CompactionPreference,
} from "@polyth/contracts/compaction-policy";
import type { SessionProjection } from "@polyth/contracts";

export interface ChatMemoryState {
  /** What the person asked for. */
  chosen: CompactionPreference;
  /** What the harness can actually do with it. */
  effective: CompactionPreference;
  /** The chat has its own choice instead of following the person's default. */
  overridden: boolean;
  canSwitchOffAutoCompaction: boolean;
}

export function chatMemoryState(
  session: Pick<SessionProjection, "compactionPreference" | "parentId" | "purpose">,
  personDefault: CompactionPreference,
  canSwitchOffAutoCompaction: boolean,
): ChatMemoryState {
  const chosen = effectiveCompactionPreference(
    session.compactionPreference,
    session.parentId || session.purpose ? undefined : personDefault,
  );
  return {
    chosen,
    effective: supportedCompactionPreference(chosen, canSwitchOffAutoCompaction),
    overridden: session.compactionPreference !== undefined,
    canSwitchOffAutoCompaction,
  };
}

/** A person who compacts by hand is asked to, once memory is nearly full. */
export function chatMemoryReminderDue(state: ChatMemoryState, percent: number | null | undefined): boolean {
  return state.effective.mode === "manual"
    && typeof percent === "number"
    && percent >= COMPACTION_REMINDER_PERCENT;
}

/** What to store for a pick: the same as the default follows the default, so a
 *  later change of the default still reaches this chat. */
export function chatMemoryOverrideFor(
  pick: CompactionPreference,
  personDefault: CompactionPreference,
): CompactionPreference | null {
  return pick.mode === personDefault.mode && pick.percent === personDefault.percent ? null : pick;
}

/** What switching this chat to a model with a smaller window means for the
 *  next message, so the composer can say it before the person sends (the
 *  server decides the same with `compactionDueForNextModel`):
 *  `compact` — Polyth summarizes the conversation first, on the old model;
 *  `manual` — the person compacts by hand, so nothing does it for them;
 *  undefined — it still fits, the window is not smaller, or nothing is known. */
export function modelSwitchOverflow(
  state: ChatMemoryState,
  window: { usedTokens?: number | undefined; currentTokens?: number | undefined; nextTokens?: number | undefined },
): "compact" | "manual" | undefined {
  const { usedTokens, currentTokens, nextTokens } = window;
  if (usedTokens === undefined || nextTokens === undefined || !Number.isFinite(usedTokens)) return undefined;
  if (currentTokens !== undefined && nextTokens >= currentTokens) return undefined;
  const latest = compactionLatestTokens(nextTokens);
  if (latest === undefined || usedTokens < latest) return undefined;
  return state.effective.mode === "manual" ? "manual" : "compact";
}
