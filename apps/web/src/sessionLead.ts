import type { SessionRowStatus } from "./sessionStatus.ts";

/** What a chat row's state column shows. Live state always wins; a pinned
 *  chat at rest shows its pin there instead of leaving the column empty. */
export type SessionLeadMark =
  | "opening"
  | "people"
  | "working"
  | "reconciling"
  | "needs-reply"
  | "needs-approval"
  | "failed"
  | "epoch-pending"
  | "unknown"
  | "rate-limited"
  | "unread"
  | "pin";

export interface SessionLeadInput {
  status: SessionRowStatus;
  /** The chat is being opened (the row shows a loading spinner). */
  opening: boolean;
  /** A conversation has no agent state: its slot names its kind instead. */
  conversation: boolean;
  pinned: boolean;
}

/** The one decision behind both the rendered mark and the row's
 *  `data-lead` flag (desktop SessionList and the phone navigator), so the two
 *  cannot drift. `null` means the column is empty. */
export function sessionLeadMark({ status, opening, conversation, pinned }: SessionLeadInput): SessionLeadMark | null {
  // Opening is live feedback for the tap that just happened: it wins even
  // over a conversation's kind mark.
  if (opening) return "opening";
  if (conversation) return "people";
  switch (status.kind) {
    case "working":
    case "reconciling":
    case "needs-reply":
    case "needs-approval":
    case "failed":
    case "epoch-pending":
    case "unknown":
    case "rate-limited":
    case "unread":
      return status.kind;
    default:
      return pinned ? "pin" : null;
  }
}

/** `data-lead` on a row: `empty` lets the highlight start at the title;
 *  `select` while the selection checkbox owns the column. */
export function sessionLeadState(mark: SessionLeadMark | null, selecting: boolean): "mark" | "empty" | "select" {
  if (selecting) return "select";
  return mark === null ? "empty" : "mark";
}
