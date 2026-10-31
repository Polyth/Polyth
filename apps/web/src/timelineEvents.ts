import type { SessionEvent } from "@polyth/contracts";

export type TimelineEntry<Row> =
  | { kind: "timeline-row"; id: string; seq: number; row: Row }
  | { kind: "timeline-event"; id: string; seq: number; event: SessionEvent };

/** A rendered row plus the seq range it spans. A single message spans one seq;
 *  a projected activity group spans its members' seq range. */
export interface SpanningRow<Row> {
  id: string;
  seq: number;
  /** Inclusive upper bound of the row's seq range (defaults to `seq`). */
  endSeq?: number;
  row: Row;
}

/** Split rows whose seq range contains a visible timeline fact, so the fact
 *  interleaves chronologically instead of collecting below the whole row. A
 *  projected activity group is one row spanning many seqs; without this a
 *  compaction or harness-switch marker inside it sorts after the group.
 *
 *  `itemsOf` yields the row's ordered member items; `itemSeq` reads one item's
 *  seq; `split` rebuilds the row from a contiguous item slice (index 0 keeps
 *  the original id so React keys stay stable for the leading half). Rows with
 *  no interior boundary are passed through untouched. */
export function splitRowsAtEvents<Row, Item>(
  rows: ReadonlyArray<SpanningRow<Row>>,
  eventSeqs: readonly number[],
  itemsOf: (row: Row) => readonly Item[],
  itemSeq: (item: Item) => number,
  split: (row: Row, items: Item[], index: number) => Row,
): Array<SpanningRow<Row>> {
  const boundaries = [...new Set(eventSeqs)].toSorted((a, b) => a - b);
  const out: Array<SpanningRow<Row>> = [];
  for (const entry of rows) {
    const start = entry.seq;
    const end = entry.endSeq ?? entry.seq;
    const cuts = end > start ? boundaries.filter((seq) => seq > start && seq < end) : [];
    const items = cuts.length > 0 ? itemsOf(entry.row) : [];
    if (cuts.length === 0 || items.length < 2) {
      out.push(entry);
      continue;
    }
    let bucket: Item[] = [];
    let index = 0;
    let cutIndex = 0;
    const emit = () => {
      if (bucket.length === 0) return;
      out.push({ id: entry.id, seq: itemSeq(bucket[0]!), endSeq: itemSeq(bucket.at(-1)!), row: split(entry.row, bucket, index) });
      bucket = [];
      index += 1;
    };
    for (const item of items) {
      // Consume each boundary once: a cut splits the group exactly where it
      // falls, not before every following item.
      while (cutIndex < cuts.length && cuts[cutIndex]! < itemSeq(item)) {
        emit();
        cutIndex += 1;
      }
      bucket.push(item);
    }
    emit();
  }
  return out;
}

/** Merge package-declared timeline facts with rendered rows without teaching
 * the shell which event domains exist. Event sequence is the sole ordering
 * authority, so repeated harness switches survive pagination and refresh.
 * Facts inside `hiddenRanges` (`[from, to)`, e.g. a rewound tail) stay out of
 * the visible flow together with the rows they belong to. */
export function mergeTimelineEntries<Row>(
  rows: Array<{ id: string; seq: number; row: Row }>,
  events: readonly SessionEvent[],
  eventTypes: ReadonlySet<string>,
  minimumSeq = 0,
  hiddenRanges: ReadonlyArray<readonly [number, number]> = [],
): Array<TimelineEntry<Row>> {
  const hidden = (seq: number) => hiddenRanges.some(([from, to]) => seq >= from && seq < to);
  return [
    ...rows.map((row) => ({ kind: "timeline-row" as const, ...row })),
    ...events
      .filter((event) => event.seq >= minimumSeq && eventTypes.has(event.type) && !hidden(event.seq))
      .map((event) => ({ kind: "timeline-event" as const, id: `event-${event.id}`, seq: event.seq, event })),
  ].toSorted((left, right) => left.seq - right.seq || (left.kind === "timeline-event" ? -1 : 1));
}
