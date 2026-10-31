// Drafts in the navigator. A draft is an ordinary canonical session: holding
// Send parks the message as a chat's unsent composer draft instead of
// sending it. A chat that never ran a turn and holds a draft *is* a draft;
// a chat with history shows the same mark while its draft waits unsent.
import type { SessionProjection } from "@polyth/contracts";
import { sessionDraftPreview } from "@polyth/contracts";

type DraftFields = Pick<SessionProjection, "summary" | "draft" | "draftPreview" | "lastTurnAt">;

/** The reader's unsent draft, first line only. A summary carries just the
 *  preview (any `draft` on it is stale cached detail); a full projection
 *  carries the text itself. */
export function sessionDraftLine(session: DraftFields): string | undefined {
  if (session.summary) return session.draftPreview || undefined;
  return session.draftPreview || sessionDraftPreview(session.draft);
}

/** Navigator mark. The open chat already shows its draft in the composer, so
 *  only a chat that has never run marks itself while open. */
export function sessionDraftMark(session: DraftFields, active: boolean): string | undefined {
  const line = sessionDraftLine(session);
  if (!line) return undefined;
  if (active && session.lastTurnAt != null) return undefined;
  return line;
}

/** A chat that never ran is named by its draft until it gets a title. */
export function draftTitleSource(session: DraftFields): string | undefined {
  return session.lastTurnAt == null ? sessionDraftLine(session) : undefined;
}
