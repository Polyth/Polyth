import type { TurnState } from "./reduce.ts";

/** Presentation identity for the ordinary terminal turn notice. */
export function transientTurnNoticeKey(
  sessionId: string | null,
  turn: Pick<TurnState, "turnId" | "status"> | null,
): string | null {
  if (
    sessionId === null
    || turn === null
    || (turn.status !== "failed" && turn.status !== "aborted")
  ) return null;
  return `${sessionId}:${turn.turnId}:${turn.status}`;
}
