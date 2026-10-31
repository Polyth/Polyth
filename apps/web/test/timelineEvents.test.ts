import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@polyth/contracts";
import { mergeTimelineEntries, splitRowsAtEvents } from "../src/timelineEvents.ts";

const event = (seq: number, type: string): SessionEvent => ({
  id: `e-${seq}`, sessionId: "s", seq, time: seq, type, data: {}, v: 1,
});

test("every contributed switch event remains at its chronological boundary", () => {
  const entries = mergeTimelineEntries(
    [{ id: "user", seq: 1, row: "user" }, { id: "a", seq: 3, row: "answer-a" }, { id: "b", seq: 7, row: "answer-b" }],
    [event(2, "runtime/recovered"), event(4, "harness/switched"), event(6, "harness/switched")],
    new Set(["harness/switched"]),
  );
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.seq]), [
    ["timeline-row", 1], ["timeline-row", 3], ["timeline-event", 4], ["timeline-event", 6], ["timeline-row", 7],
  ]);
});

test("windowed timelines omit contributed events before the visible boundary", () => {
  const entries = mergeTimelineEntries([{ id: "tail", seq: 10, row: "tail" }], [event(4, "harness/switched"), event(11, "harness/switched")], new Set(["harness/switched"]), 10);
  assert.deepEqual(entries.map((entry) => entry.seq), [10, 11]);
});

test("contributed events inside a rewound branch stay hidden with its rows", () => {
  const entries = mergeTimelineEntries(
    [{ id: "kept", seq: 2, row: "kept" }, { id: "replacement", seq: 8, row: "replacement" }],
    [event(3, "harness/switched"), event(6, "harness/switched"), event(9, "harness/switched")],
    new Set(["harness/switched"]),
    0,
    [[3, 7]],
  );
  assert.deepEqual(entries.map((entry) => entry.seq), [2, 8, 9]);
});

test("a marker inside a spanning group splits it instead of sorting after it", () => {
  // One activity group spans seqs 4..10; the compaction marker at seq 7 must
  // land between its two halves, not below the whole block.
  const group = { id: "activity-a", kind: "activity" as const, items: [
    { id: "t1", eventSeq: 4 }, { id: "t2", eventSeq: 5 },
    { id: "t3", eventSeq: 8 }, { id: "t4", eventSeq: 10 },
  ] };
  const rows = splitRowsAtEvents(
    [{ id: group.id, seq: 4, endSeq: 10, row: group }],
    [7],
    (row) => row.items,
    (item) => item.eventSeq,
    (row, items, index) => ({ ...row, id: index === 0 ? row.id : `${row.id}-split-${index}`, items }),
  );
  assert.deepEqual(rows.map((entry) => [entry.row.id, entry.seq, entry.endSeq]), [
    ["activity-a", 4, 5], ["activity-a-split-1", 8, 10],
  ]);
  const merged = mergeTimelineEntries(
    rows.map((entry) => ({ id: entry.row.id, seq: entry.seq, row: entry.row })),
    [event(7, "session/compacted")],
    new Set(["session/compacted"]),
  );
  assert.deepEqual(merged.map((entry) => entry.kind === "timeline-event" ? "event" : entry.row.id),
    ["activity-a", "event", "activity-a-split-1"]);
});

test("a marker at a spanning group's edges does not split it", () => {
  const group = { id: "activity-b", kind: "activity" as const, items: [{ id: "t1", eventSeq: 4 }, { id: "t2", eventSeq: 9 }] };
  const split = splitRowsAtEvents(
    [{ id: group.id, seq: 4, endSeq: 9, row: group }],
    [4, 9, 12],
    (row) => row.items,
    (item) => item.eventSeq,
    (row, items, index) => ({ ...row, id: index === 0 ? row.id : `${row.id}-split-${index}`, items }),
  );
  assert.deepEqual(split.map((entry) => [entry.row.id, entry.seq, entry.endSeq]), [["activity-b", 4, 9]]);
});

test("non-spanning rows pass through the splitter unchanged", () => {
  const rows = splitRowsAtEvents(
    [{ id: "answer", seq: 6, row: "answer" }],
    [5, 7],
    () => [],
    () => 0,
    (row) => row,
  );
  assert.deepEqual(rows, [{ id: "answer", seq: 6, row: "answer" }]);
});
