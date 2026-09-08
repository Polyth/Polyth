import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@polyth/contracts";
import { mergeTimelineEntries } from "../src/timelineEvents.ts";

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
