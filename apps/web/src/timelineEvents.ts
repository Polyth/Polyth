import type { SessionEvent } from "@polyth/contracts";

export type TimelineEntry<Row> =
  | { kind: "timeline-row"; id: string; seq: number; row: Row }
  | { kind: "timeline-event"; id: string; seq: number; event: SessionEvent };

/** Merge package-declared timeline facts with rendered rows without teaching
 * the shell which event domains exist. Event sequence is the sole ordering
 * authority, so repeated harness switches survive pagination and refresh. */
export function mergeTimelineEntries<Row>(
  rows: Array<{ id: string; seq: number; row: Row }>,
  events: readonly SessionEvent[],
  eventTypes: ReadonlySet<string>,
  minimumSeq = 0,
): Array<TimelineEntry<Row>> {
  return [
    ...rows.map((row) => ({ kind: "timeline-row" as const, ...row })),
    ...events
      .filter((event) => event.seq >= minimumSeq && eventTypes.has(event.type))
      .map((event) => ({ kind: "timeline-event" as const, id: `event-${event.id}`, seq: event.seq, event })),
  ].toSorted((left, right) => left.seq - right.seq || (left.kind === "timeline-event" ? -1 : 1));
}
