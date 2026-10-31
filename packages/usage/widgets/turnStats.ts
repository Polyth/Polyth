// The status bar's turn readout: a live timer while a turn runs, then the last
// turn's wall time and response speed. Both come from the same canonical
// events and timing derivation as the Usage dashboard (`collect.ts`), so the
// bar never disagrees with the Session card.
import type { SessionEvent } from "@polyth/contracts";
import type { UsageObservation } from "../src/analytics/contracts.ts";

const TURN_END = new Set(["turn/stopped", "turn/failed"]);

/** Start of the turn that is still open, or null when the last one ended. */
export function activeTurnStart(events: readonly Pick<SessionEvent, "type" | "time">[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (TURN_END.has(event.type)) return null;
    if (event.type === "turn/started") return event.time;
  }
  return null;
}

export interface TurnStats {
  /** Wall time of the turn. */
  totalMs: number;
  /** Output tokens over model-active time (the dashboard's response tok/s);
   *  null without output or a measured model time. */
  tokensPerSecond: number | null;
}

/** The most recent finished turn that has measured timing. */
export function lastTurnStats(observations: readonly UsageObservation[]): TurnStats | null {
  let latest: { turnId: string; at: number } | null = null;
  for (const observation of observations) {
    if (!observation.turnId || observation.timing?.totalMs === undefined) continue;
    if (!latest || observation.timestamp >= latest.at) latest = { turnId: observation.turnId, at: observation.timestamp };
  }
  if (!latest) return null;
  const turn = observations.filter((observation) => observation.turnId === latest.turnId);
  // Timing is a turn-level measurement repeated on each of its observations.
  const timing = turn.find((observation) => observation.timing)!.timing!;
  const output = turn.reduce((sum, observation) => sum + (observation.tokens.output ?? 0), 0);
  const modelMs = timing.modelMs ?? 0;
  return {
    totalMs: timing.totalMs ?? 0,
    tokensPerSecond: output > 0 && modelMs > 0 ? output / (modelMs / 1000) : null,
  };
}

/** Identity of the newest event the readout depends on; chunks do not move it. */
export function turnTail(events: readonly SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "usage/recorded" || event.type === "assistant/message" || event.type === "turn/started" || TURN_END.has(event.type)) {
      return event.id;
    }
  }
  return "";
}
