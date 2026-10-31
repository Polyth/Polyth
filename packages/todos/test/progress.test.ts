import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@polyth/contracts";
import {
  formatCost,
  formatElapsed,
  formatTokens,
  progressElapsed,
  sessionProgress,
  subagentState,
  summarizeSubagents,
  type SubagentSource,
} from "../src/index.ts";
import { TODO_LOCALES, fill, todoFormat, todoStrings } from "../widgets/strings.ts";

let seq = 0;
const ev = (type: string, time: number, data: Record<string, unknown>): SessionEvent =>
  ({ id: `e${++seq}`, sessionId: "s", seq, time, type, data: data as SessionEvent["data"], v: 1 });
const tasks = (time: number, items: Array<[string, string]>) =>
  ev("task/snapshot", time, { listId: "todo", revision: time, items: items.map(([text, status], i) => ({ id: `t${i}`, text, status })) });
const agents = (list: Array<Record<string, unknown>>) => ev("subagent/snapshot", 1, { revision: 1, agents: list });

test("progress counts, current item and elapsed span", () => {
  const events = [
    tasks(1000, [["a", "active"], ["b", "pending"]]),
    tasks(5000, [["a", "done"], ["b", "active"]]),
  ];
  const p = sessionProgress(events);
  assert.equal(p.total, 2);
  assert.equal(p.done, 1);
  assert.equal(p.current?.text, "b");
  assert.equal(p.startedAt, 1000);
  assert.equal(p.endedAt, undefined);
  assert.equal(progressElapsed(p, 9000), 8000);
});

test("elapsed freezes when the list settles and restarts after a clear", () => {
  const settled = sessionProgress([tasks(1000, [["a", "active"]]), tasks(4000, [["a", "done"]])]);
  assert.equal(settled.endedAt, 4000);
  assert.equal(progressElapsed(settled, 99999), 3000);

  const restarted = sessionProgress([
    tasks(1000, [["a", "done"]]),
    tasks(2000, []),
    tasks(7000, [["b", "active"]]),
  ]);
  assert.equal(restarted.startedAt, 7000);
  assert.equal(restarted.total, 1);

  const none = sessionProgress([]);
  assert.equal(none.total, 0);
  assert.equal(progressElapsed(none, 5), undefined);
});

test("formatters", () => {
  assert.equal(formatElapsed(900), "0s");
  assert.equal(formatElapsed(65_000), "1m 05s");
  assert.equal(formatElapsed(3_900_000), "1h 05m");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(24_000), "24k");
  assert.equal(formatTokens(2_500_000), "2.5M");
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(1.234), "$1.23");
});

test("sub-agent state prefers the child's live status over a stale snapshot", () => {
  assert.equal(subagentState("completed"), "done");
  assert.equal(subagentState("running", "idle"), "idle");
  assert.equal(subagentState("done", "working"), "running");
  assert.equal(subagentState("weird", "failed"), "failed");
  assert.equal(subagentState(undefined), "unknown");
});

const source = (logs: Record<string, SessionEvent[]>, sessions: SubagentSource["session"] extends (id: string) => infer R ? Record<string, R> : never): SubagentSource => ({
  events: (id) => logs[id] ?? [],
  session: (id) => sessions[id],
});

test("sub-agent panel rolls tokens and cost up through nested children", () => {
  const summary = summarizeSubagents("root", source(
    {
      root: [agents([{ sessionId: "c1", label: "Explore", status: "running", currentTask: "grep" }, { sessionId: "c2", label: "", status: "done" }])],
      c1: [agents([{ sessionId: "g1", label: "Deep", status: "done" }])],
    },
    {
      c1: { status: "working", title: "c1", tokenTotals: { input: 100, output: 50 }, costTotal: 0.1 },
      c2: { status: "finished", title: "Review", tokenTotals: { input: 10, output: 5 }, costTotal: 0.02 },
      g1: { status: "idle", title: "g1", tokenTotals: { input: 1000, output: 500 }, costTotal: 0.5 },
    },
  ));
  assert.deepEqual(summary.rows.map((r) => [r.sessionId, r.depth, r.state, r.tokens]), [
    ["c1", 0, "running", 1650],
    ["g1", 1, "done", 1500],
    ["c2", 0, "done", 15],
  ]);
  assert.equal(summary.rows[2]!.label, "Review");
  assert.equal(summary.rows[0]!.currentTask, "grep");
  assert.equal(summary.tokens, 1665);
  assert.ok(Math.abs(summary.cost - 0.62) < 1e-9);
  assert.equal(summary.running, 1);
  assert.equal(summary.partial, false);
});

test("missing projections are partial, cycles and duplicates terminate", () => {
  const summary = summarizeSubagents("root", source(
    {
      root: [agents([{ sessionId: "a", status: "running" }, { sessionId: "a", status: "running" }, { sessionId: "root" }])],
      a: [agents([{ sessionId: "root" }, { sessionId: "a" }])],
    },
    {},
  ));
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0]!.tokens, undefined);
  assert.equal(summary.partial, true);
  assert.equal(summary.tokens, 0);
  assert.equal(summarizeSubagents("x", source({}, {})).rows.length, 0);
});

test("uses the newest snapshot and ignores malformed agents", () => {
  const summary = summarizeSubagents("root", source(
    { root: [agents([{ sessionId: "old" }]), agents([null as never, { label: "no id" }, { sessionId: "new", label: "N", status: "failed" }])] },
    {},
  ));
  assert.deepEqual(summary.rows.map((r) => [r.sessionId, r.state]), [["new", "failed"]]);
});

test("strings: every host locale covers every en key and fill interpolates", () => {
  const en = todoStrings("en");
  for (const [locale, strings] of Object.entries(TODO_LOCALES)) {
    assert.deepEqual(Object.keys(strings).sort(), Object.keys(en).sort(), locale);
    for (const [key, value] of Object.entries(strings)) {
      const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(slots(value), slots(en[key as keyof typeof en]), `${locale}.${key}`);
    }
  }
  assert.equal(todoStrings("uk-UA"), TODO_LOCALES.uk);
  assert.equal(todoStrings("pt-PT"), TODO_LOCALES.pt);
  assert.equal(todoStrings("zh"), TODO_LOCALES["zh-CN"]);
  assert.equal(todoStrings("xx"), en);
  assert.notEqual(todoStrings("fr").progressTitle, en.progressTitle);
  assert.equal(fill(en.progressLabel, { done: 1, total: 3 }), "Task progress: 1 of 3 completed");
});

test("formatting follows the host locale", () => {
  const en = todoFormat("en");
  assert.equal(en.elapsed(754_000), "12 min 34 sec");
  assert.equal(en.elapsed(3_900_000), "1 hr 5 min");
  assert.equal(en.tokens(203_400), "203K");
  assert.equal(en.cost(14.76), "$14.76");
  assert.equal(en.cost(0.004), "<$0.01");
  assert.equal(todoFormat("uk").elapsed(754_000), "12 хв 34 с");
  assert.equal(todoFormat("not a locale").count(1200), "1,200");
});
