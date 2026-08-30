import type { SessionEvent } from "@polyth/contracts";

export interface EffectiveHistory {
  /** Visible events in order; rewind markers themselves are excluded. */
  events: SessionEvent[];
  /** Tail hidden by the currently active rewind marker (empty when none). */
  hidden: SessionEvent[];
  /** The active (unresolved) rewind marker, if any. */
  rewind: { markerSeq: number; atSeq: number } | null;
}

export function effectiveHistory(events: readonly SessionEvent[]): EffectiveHistory {
  let visibleEvents: SessionEvent[] = [];
  let hidden: { markerSeq: number; atSeq: number; events: SessionEvent[] } | null = null;

  for (const ev of events) {
    if (ev.type === "session/rewound") {
      const atSeq = Number((ev.data as { atSeq?: unknown }).atSeq);
      if (Number.isSafeInteger(atSeq) && atSeq > 0) {
        hidden = { markerSeq: ev.seq, atSeq, events: visibleEvents.filter((item) => item.seq >= atSeq) };
        visibleEvents = visibleEvents.filter((item) => item.seq < atSeq);
      }
      continue;
    }
    if (ev.type === "session/rewind-cleared" && hidden) {
      const d = ev.data as { rewindSeq?: unknown; replaced?: unknown };
      const markerMatches = d.rewindSeq === undefined || Number(d.rewindSeq) === hidden.markerSeq;
      if (markerMatches) {
        if (d.replaced !== true) visibleEvents.push(...hidden.events);
        hidden = null;
      }
      continue;
    }
    visibleEvents.push(ev);
  }

  return { events: visibleEvents, hidden: hidden?.events ?? [], rewind: hidden ? { markerSeq: hidden.markerSeq, atSeq: hidden.atSeq } : null };
}

export const recoveredUserText = (text: string, recoveryContext?: string): string =>
  recoveryContext ? `${recoveryContext}\n\n${text}` : text;
