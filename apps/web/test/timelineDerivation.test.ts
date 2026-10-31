import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import { createModelCache, buildModel, type RenderMessage } from "../src/reduce.ts";
import { createTimelineDerivation } from "../src/timelineDerivation.ts";
import { appendEventSegments } from "../src/eventSegments.ts";
import { groupActivity, mergeThinking, activityGroup, type ActivityGroup, type ActivityItem } from "../src/utils.ts";
import { mergeTimelineEntries, splitRowsAtEvents, type SpanningRow } from "../src/timelineEvents.ts";

const visible = (m: RenderMessage) => !m.undone && (m.kind !== "assistant" || m.text.trim() !== "" || m.reasoning.trim() !== "");
test("steady streaming only visits the changed conversation frontier", () => {
  const cache = createModelCache();
  const derive = createTimelineDerivation();
  let events: SessionEvent[] = [];
  const add = (type: string, data: SessionEvent["data"]) => {
    const seq = events.length + 1;
    events = appendEventSegments(events, [{ id: String(seq), sessionId: "scaling", seq, time: seq, type, data, v: 1 }]);
  };
  for (let i = 0; i < 500; i++) {
    add("user/message", { text: "prompt" });
    add("assistant/message", { partId: String(i), text: "completed response" });
  }
  add("user/message", { text: "current prompt" });
  add("assistant/chunk", { partId: "active", text: "first" });
  derive(cache.get("scaling", events), "collapsed", "grouped", visible);
  add("assistant/chunk", { partId: "active", text: "second" });
  derive(cache.get("scaling", events), "collapsed", "grouped", visible);
  let visits = 0;
  add("assistant/chunk", { partId: "active", text: "third" });
  derive(cache.get("scaling", events), "collapsed", "grouped", (m) => { visits++; return visible(m); });
  assert.ok(visits <= 4, `visited ${visits} historical messages`);
});

test("stream frontiers preserve reference replay and all grouping modes, including skipped renders and rewind", () => {
  const cache = createModelCache();
  const views = [createTimelineDerivation(), createTimelineDerivation(), createTimelineDerivation()];
  let events: SessionEvent[] = [];
  const emit = (type: string, data: SessionEvent["data"]) => {
    const seq = events.length + 1;
    events = appendEventSegments(events, [{ id: String(seq), sessionId: "s", seq, time: seq, type, data, v: 1 }]);
    return cache.get("s", events);
  };
  for (let turn = 0; turn < 60; turn++) {
    const target = events.length + 1;
    emit("user/message", { text: `prompt ${turn}` });
    emit("turn/started", { turnId: String(turn) });
    emit("tool/call", { callId: `t${turn}`, tool: "read", input: {} });
    emit("assistant/reasoning-chunk", { partId: `p${turn}`, text: "thinking" });
    for (let chunk = 0; chunk < 8; chunk++) {
      emit("assistant/reasoning-chunk", { partId: `p${turn}`, text: " continued" });
      const model = emit("assistant/chunk", { partId: `p${turn}`, text: " word" });
      assert.deepEqual(model, buildModel(events));
      for (const [i, mode] of (["collapsed", "expanded", "activity"] as const).entries()) {
        const result = views[i]!(model, mode, "grouped", visible);
        assert.deepEqual(result.messages, model.messages.filter(visible));
        assert.deepEqual(result.rows, groupActivity(mergeThinking(model.messages.filter(visible)), mode, "grouped"));
      }
    }
    emit("tool/result", { callId: `t${turn}`, output: "done" });
    emit("assistant/message", { partId: `p${turn}`, text: "answer" });
    emit("turn/stopped", { turnId: String(turn), reason: "completed" });
    if (turn % 10 === 0) {
      emit("session/rewound", { atSeq: target });
      const model = emit("assistant/chunk", { partId: `p${turn}`, text: " stale" });
      assert.deepEqual(views[0]!(model, "collapsed", "grouped", visible).rows, groupActivity(mergeThinking(model.messages.filter(visible))));
      emit("session/rewind-cleared", {});
    }
  }
});

test("a composer `!` command is its own timeline row, never folded into agent activity", () => {
  const events: SessionEvent[] = [];
  const add = (type: string, data: SessionEvent["data"], producerPlugin?: string) => {
    const seq = events.length + 1;
    events.push({ id: String(seq), sessionId: "s", seq, time: seq, type, data, v: 1, ...(producerPlugin ? { producerPlugin } : {}) });
  };
  add("user/message", { text: "prompt" });
  add("tool/call", { callId: "agent", tool: "read", input: {} });
  add("tool/result", { callId: "agent", output: "done" });
  add("tool/call", { callId: "shell_1", tool: "shell", input: { command: "git status" } }, "composer-shell");
  add("tool/result", { callId: "shell_1", tool: "shell", output: "clean\n", title: "!git status", metadata: { exitCode: 0 } }, "composer-shell");
  add("tool/call", { callId: "agent2", tool: "read", input: {} });
  const model = buildModel(events);
  const shell = model.messages.find((m) => m.id === "shell_1");
  assert.equal(shell?.kind === "tool" && shell.composerShell, true);
  assert.equal(shell?.kind === "tool" && shell.title, "!git status");
  assert.equal(model.messages.find((m) => m.id === "agent")?.kind === "tool"
    && (model.messages.find((m) => m.id === "agent") as { composerShell?: boolean }).composerShell, undefined);
  const rows = groupActivity(mergeThinking(model.messages.filter(visible)), "collapsed", "grouped");
  assert.deepEqual(rows.map((row) => row.kind === "activity" ? `activity:${row.tools.map((t) => t.id).join(",")}` : row.id), [
    model.messages[0]!.id,
    "activity:agent",
    "shell_1",
    "activity:agent2",
  ]);
});

test("a compaction marker splits the activity block it happened inside", () => {
  const events: SessionEvent[] = [];
  const add = (type: string, data: SessionEvent["data"]) => {
    const seq = events.length + 1;
    events.push({ id: String(seq), sessionId: "s", seq, time: seq, type, data, v: 1 });
  };
  add("user/message", { text: "prompt" });
  add("turn/started", { turnId: "1" });
  add("tool/call", { callId: "before", tool: "read", input: {} });
  add("tool/result", { callId: "before", output: "done" });
  // The compaction happens mid-turn: its seq sits inside the group's range.
  add("session/compacted", { summary: "condensed" });
  const compactionSeq = events.at(-1)!.seq;
  add("tool/call", { callId: "after", tool: "read", input: {} });
  add("tool/result", { callId: "after", output: "done" });
  add("assistant/message", { partId: "p", text: "answer" });
  add("turn/stopped", { turnId: "1", reason: "completed" });
  const model = buildModel(events);
  const rows = groupActivity(mergeThinking(model.messages.filter(visible)), "collapsed", "grouped");
  const group = rows.find((row) => row.kind === "activity");
  assert.equal(group?.kind === "activity" && group.tools.map((t) => t.id).join(","), "before,after");
  const split = splitRowsAtEvents<ActivityGroup | RenderMessage, ActivityItem>(
    rows.map((row): SpanningRow<ActivityGroup | RenderMessage> => row.kind === "activity"
      ? { id: row.id, seq: Math.min(...row.items.map((item) => item.eventSeq)), endSeq: Math.max(...row.items.map((item) => item.eventSeq)), row }
      : { id: row.id, seq: row.eventSeq, row }),
    [compactionSeq],
    (row) => row.kind === "activity" ? row.items : [],
    (item) => item.eventSeq,
    (row, items, index) => row.kind === "activity" ? activityGroup(row.id, items, index) : row,
  );
  assert.deepEqual(split.filter((entry) => entry.row.kind === "activity").map((entry) => entry.row.kind === "activity" && entry.row.tools.map((t) => t.id)), [
    ["before"], ["after"],
  ]);
  const merged = mergeTimelineEntries(
    split.map((entry) => ({ id: entry.row.id, seq: entry.seq, row: entry.row })),
    events,
    new Set(["session/compacted"]),
  );
  // The marker sits between the two halves instead of below the whole block.
  assert.deepEqual(merged.map((entry) => entry.kind === "timeline-event" ? "compacted" : entry.row.kind === "activity" ? `activity:${entry.row.tools.map((t) => t.id).join(",")}` : entry.row.kind), [
    "user", "activity:before", "compacted", "activity:after", "assistant",
  ]);
});
