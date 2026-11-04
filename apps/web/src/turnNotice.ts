import type { TurnState } from "./reduce.ts";

/** Presentation identity for an ordinary failed-turn notice. User-aborted
 *  turns stay silent; provider-limit stops own their inline recovery surface
 *  even after its wait ends; a failure on a harness the session has switched
 *  (or is switching) away from is no longer the session's last turn to retry. */
export function transientTurnNoticeKey(
  sessionId: string | null,
  turn: Pick<TurnState, "turnId" | "status" | "harnessId" | "limit" | "providerLimited" | "contextFull"> | null,
  currentHarnessId?: string | null,
): string | null {
  if (
    sessionId === null
    || turn === null
    || turn.status !== "failed"
    || turn.limit
    || turn.providerLimited
    // The composer's row says why and offers the way out; "Retry" could not help.
    || turn.contextFull
    || (turn.harnessId && currentHarnessId && turn.harnessId !== currentHarnessId)
  ) return null;
  return `${sessionId}:${turn.turnId}:${turn.status}`;
}
