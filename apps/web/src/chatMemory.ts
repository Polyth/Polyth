// Which "Chat memory" choice applies to a chat, for the card and the reminder.
// The server decides with the same rules (`compactionPreferenceOf`) from the
// acting person's default; in a shared chat that person may be someone else.
import {
  COMPACTION_REMINDER_PERCENT,
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
