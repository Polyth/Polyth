import type { TurnState } from "./reduce.ts";

/** Presentation identity for an ordinary failed-turn notice. User-aborted turns stay silent. */
export function transientTurnNoticeKey(
  sessionId: string | null,
  turn: Pick<TurnState, "turnId" | "status"> | null,
): string | null {
  if (
    sessionId === null
    || turn === null
    || turn.status !== "failed"
  ) return null;
  return `${sessionId}:${turn.turnId}:${turn.status}`;
}
