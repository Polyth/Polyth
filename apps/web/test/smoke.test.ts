// DOM-free smoke tests for the web render pipeline: reducer, sync dedupe, slots, goal, utils.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel, emptyModel, reduceEvent, type GoalState } from "../src/reduce.ts";
import { createSeqDedupe } from "../src/sync.ts";
import { registerSlot, listSlots, renderSlot } from "../src/slots.ts";
import { applyTerminalChunk, filterCommands, filterSnippets, goalChecklist, parseDiffLines } from "../src/utils.ts";
import { ago, displaySessionTitle, isPlaceholderTitle, modelBadge, providerColor, titleFromPrompt } from "../src/format.ts";
import {
  DEFAULT_SETTINGS,
  formatModelRef,
  friendlyError,
  modKeyLabel,
  normalizeSettings,
  parseModelRef,
  parseSettings,
  serializeSettings,
  shortcutLabel,
} from "../src/settings.ts";

let seqCounter = 0;
function ev(type: string, data: JsonObject, sessionId = "s1"): SessionEvent {
  seqCounter += 1;
  return { id: `e${seqCounter}`, sessionId, seq: seqCounter, time: 1_700_000_000_000 + seqCounter, type, data, v: 1 };
}

test("assistant chunks stream into one message and finalize on assistant/message", () => {
  const events = [
    ev("user/message", { text: "hi" }),
    ev("turn/started", { turnId: "t1", model: { providerID: "openai", modelID: "gpt-x" }, agent: "build" }),
    ev("assistant/chunk", { partId: "p1", text: "Hel" }),
    ev("assistant/chunk", { partId: "p1", text: "lo" }),
    ev("assistant/reasoning-chunk", { partId: "p1", text: "think " }),
    ev("assistant/reasoning-chunk", { partId: "p1", text: "hard" }),
  ];

  // Mid-stream: chunks accumulate, not finalized.
  const streaming = buildModel(events);
  assert.equal(streaming.messages.length, 2);
  const a = streaming.messages[1];
  assert.equal(a?.kind, "assistant");
  assert.equal((a as { text: string }).text, "Hello");
  assert.equal((a as { reasoning: string }).reasoning, "think hard");
  assert.equal((a as { finalized: boolean }).finalized, false);
  assert.equal(streaming.turn?.status, "working");

  // Finalize: assistant/message replaces streamed text, turn stops, usage totals.
  const done = reduceEvent(
    streaming,
    ev("assistant/message", { partId: "p1", text: "Hello!", reasoning: "think hard", tokens: { input: 10, output: 5 }, cost: 0.001 }),
  );
  const done2 = reduceEvent(
    done,
    ev("usage/recorded", { model: { providerID: "openai", modelID: "gpt-x" }, tokens: { input: 10, output: 5 }, cost: 0.001 }),
  );
  const stopped = reduceEvent(done2, ev("turn/stopped", { turnId: "t1", reason: "completed" }));
  const last = stopped.messages[1] as { kind: string; text: string; reasoning: string; finalized: boolean };
  assert.equal(last.kind, "assistant");
  assert.equal(last.text, "Hello!");
  assert.equal(last.reasoning, "think hard");
  assert.equal(last.finalized, true);
  assert.equal(stopped.turn?.status, "stopped");
  assert.equal(stopped.totals.input, 10);
  assert.equal(stopped.totals.output, 5);
  assert.ok(Math.abs(stopped.totals.cost - 0.001) < 1e-9);
});

test("tool call → result fills the card; call → error marks it failed", () => {
  const m = buildModel([
    ev("tool/call", { callId: "c1", tool: "read_file", input: { path: "a.ts" } }),
  ]);
  const t0 = m.messages[0] as { kind: string; status: string };
  assert.equal(t0.kind, "tool");
  assert.equal(t0.status, "pending");

  const withResult = reduceEvent(m, ev("tool/result", { callId: "c1", tool: "read_file", output: "export const x = 1", title: "a.ts" }));
  const t1 = withResult.messages[0] as { status: string; output: string; finishTime?: number };
  assert.equal(t1.status, "done");
  assert.equal(t1.output, "export const x = 1");
  assert.ok(t1.finishTime !== undefined);

  const m2 = buildModel([ev("tool/call", { callId: "c2", tool: "bash", input: { cmd: "rm -rf /" } })]);
  const withError = reduceEvent(m2, ev("tool/error", { callId: "c2", tool: "bash", error: "permission denied" }));
  const t2 = withError.messages[0] as { status: string; error: string };
  assert.equal(t2.status, "error");
  assert.equal(t2.error, "permission denied");
});

test("permission requested → resolved (and question asked → answered)", () => {
  const m = buildModel([
    ev("permission/requested", { requestId: "r1", permission: "bash", patterns: ["ls *"], tool: "bash" }),
    ev("question/asked", { requestId: "q1", questions: [{ question: "Continue?" }] }),
  ]);
  assert.equal(m.permissions.length, 1);
  assert.equal(m.permissions[0]?.status, "pending");
  assert.deepEqual(m.permissions[0]?.patterns, ["ls *"]);
  assert.equal(m.questions.length, 1);
  assert.equal(m.questions[0]?.status, "pending");

  const m2 = reduceEvent(m, ev("permission/resolved", { requestId: "r1", reply: "once" }));
  assert.equal(m2.permissions[0]?.status, "resolved");
  assert.equal(m2.permissions[0]?.reply, "once");

  const m3 = reduceEvent(m2, ev("question/answered", { requestId: "q1", answers: { "0": "yes" } }));
  assert.equal(m3.questions[0]?.status, "answered");
  assert.deepEqual(m3.questions[0]?.answers, { "0": "yes" });
});

test("replayed seq is deduped per (sessionId, seq)", () => {
  const d = createSeqDedupe();
  assert.equal(d.has("s1", 3), false);
  d.add("s1", 3);
  assert.equal(d.has("s1", 3), true); // replay of the same event → already seen
  assert.equal(d.has("s2", 3), false); // same seq, different session → not a dup
  d.add("s2", 3);
  d.add("s1", 4);
  assert.equal(d.size(), 3);
});

test("replaying the event log reconstructs an identical model (fold === buildModel)", () => {
  const events = [
    ev("user/message", { text: "hi" }),
    ev("turn/started", { turnId: "t1", model: { providerID: "anthropic", modelID: "claude-x" } }),
    ev("assistant/chunk", { partId: "p1", text: "Part 1" }),
    ev("tool/call", { callId: "c1", tool: "grep", input: { pattern: "x" } }),
    ev("tool/result", { callId: "c1", tool: "grep", output: "a.ts:1" }),
    ev("assistant/chunk", { partId: "p1", text: " Part 2" }),
    ev("assistant/message", { partId: "p1", text: "Part 1 Part 2" }),
    ev("permission/requested", { requestId: "r1", permission: "write", patterns: [] }),
    ev("permission/resolved", { requestId: "r1", reply: "reject" }),
    ev("usage/recorded", { model: { providerID: "anthropic", modelID: "claude-x" }, tokens: { input: 3, output: 7 }, cost: 0.01 }),
    ev("turn/stopped", { turnId: "t1", reason: "completed" }),
  ];
  const a = buildModel(events);
  const b = events.reduce(reduceEvent, emptyModel());
  assert.deepEqual(a.messages, b.messages);
  assert.deepEqual(a.permissions, b.permissions);
  assert.deepEqual(a.totals, b.totals);
  assert.deepEqual(a.turn, b.turn);
  assert.equal(a.version, events.length);
  assert.equal(b.version, events.length);
});

test("slot registry orders by order and disposes cleanly", () => {
  const a = registerSlot("contextRail.tabs", "a", () => "A", 20);
  const b = registerSlot("contextRail.tabs", "b", () => "B", 5);
  assert.deepEqual(listSlots("contextRail.tabs").map((i) => i.id), ["b", "a"]);
  assert.deepEqual(renderSlot("contextRail.tabs", {}), ["B", "A"]);
  a();
  assert.deepEqual(listSlots("contextRail.tabs").map((i) => i.id), ["b"]);
  b();
  assert.deepEqual(listSlots("contextRail.tabs"), []);
});

// ---- goal reducer paths -----------------------------------------------------

test("goal/attached sets initial goal state", () => {
  const m = buildModel([
    ev("goal/attached", { objective: "Refactor auth", budgetTokens: 500000, maxContinuations: 8 }),
  ]);
  assert.ok(m.goal);
  assert.equal(m.goal!.objective, "Refactor auth");
  assert.equal(m.goal!.status, "active");
  assert.equal(m.goal!.budgetTokens, 500000);
  assert.equal(m.goal!.maxContinuations, 8);
  assert.equal(m.goal!.continuations, 0);
});

test("goal/audit updates verdict", () => {
  const m = buildModel([
    ev("goal/attached", { objective: "Fix bug" }),
    ev("goal/audit", { verdict: "keep", note: "still working" }),
  ]);
  assert.equal(m.goal!.lastVerdict, "keep");
  assert.equal(m.goal!.lastReason, "still working");
});

test("goal lifecycle: paused → resumed → completed", () => {
  let m = buildModel([
    ev("goal/attached", { objective: "Write tests" }),
    ev("goal/paused", {}),
  ]);
  assert.equal(m.goal!.status, "paused");
  m = reduceEvent(m, ev("goal/resumed", {}));
  assert.equal(m.goal!.status, "active");
  m = reduceEvent(m, ev("goal/completed", {}));
  assert.equal(m.goal!.status, "completed");
});

test("goal stuck and stopped", () => {
  let m = buildModel([
    ev("goal/attached", { objective: "Deploy" }),
    ev("goal/stuck", {}),
  ]);
  assert.equal(m.goal!.status, "stuck");
  m = reduceEvent(m, ev("goal/stopped", {}));
  assert.equal(m.goal!.status, "stopped");
});

test("goal/attached with defaults when fields missing", () => {
  const m = buildModel([ev("goal/attached", {} as JsonObject)]);
  assert.ok(m.goal);
  assert.equal(m.goal!.objective, "");
  assert.equal(m.goal!.maxContinuations, 12);
  assert.equal(m.goal!.budgetTokens, 0);
});

test("goal events without a prior goal/attached are safely ignored", () => {
  const m = buildModel([ev("goal/audit", { verdict: "done" })]);
  assert.equal(m.goal, null);
});

// ---- git/snapshot safely ignored --------------------------------------------

test("git/snapshot event does not crash the reducer", () => {
  const m = buildModel([
    ev("user/message", { text: "hi" }),
    ev("git/snapshot", { branch: "main" } as JsonObject),
    ev("turn/started", { turnId: "t1" }),
  ]);
  assert.equal(m.messages.length, 1);
  assert.equal(m.version, 3);
});

// ---- user/message with raw field -------------------------------------------

test("user/message carries raw field when text differs", () => {
  const m = buildModel([
    ev("user/message", { text: "expanded prompt body", raw: "/review src/\nextra" }),
  ]);
  const um = m.messages[0];
  assert.ok(um);
  assert.equal(um!.kind, "user");
  if (um!.kind === "user") {
    assert.equal(um!.text, "expanded prompt body");
    assert.equal(um!.raw, "/review src/\nextra");
  }
});

test("user/message without raw field has no raw", () => {
  const m = buildModel([ev("user/message", { text: "plain" })]);
  const um = m.messages[0];
  assert.ok(um && um.kind === "user");
  if (um.kind === "user") {
    assert.equal(um.raw, undefined);
  }
});

test("user/message with raw === text does not set raw", () => {
  const m = buildModel([ev("user/message", { text: "hello", raw: "hello" })]);
  const um = m.messages[0];
  assert.ok(um && um.kind === "user");
  if (um.kind === "user") {
    assert.equal(um.raw, undefined);
  }
});

// ---- replay idempotency including goal --------------------------------------

test("replaying with goal events reconstructs identical model", () => {
  const events = [
    ev("user/message", { text: "start" }),
    ev("goal/attached", { objective: "Do thing" }),
    ev("goal/audit", { verdict: "keep" }),
    ev("goal/paused", {}),
    ev("goal/resumed", {}),
    ev("goal/completed", {}),
    ev("turn/started", { turnId: "t1" }),
    ev("assistant/chunk", { partId: "p1", text: "done" }),
    ev("assistant/message", { partId: "p1", text: "done" }),
    ev("usage/recorded", { tokens: { input: 5, output: 2 }, cost: 0.001 }),
    ev("turn/stopped", { turnId: "t1", reason: "completed" }),
  ];
  const a = buildModel(events);
  const b = events.reduce(reduceEvent, emptyModel());
  assert.deepEqual(a.goal, b.goal);
  assert.deepEqual(a.messages, b.messages);
  assert.deepEqual(a.totals, b.totals);
});

// ---- pure helper tests: autocomplete filtering ------------------------------

test("filterCommands matches name and description, case-insensitive", () => {
  const cmds = [
    { name: "init", description: "Analyse repo", prompt: "do init", scope: "builtin" as const },
    { name: "review", description: "Review changes", prompt: "do review", scope: "builtin" as const },
    { name: "compact", description: "Summarise conversation", prompt: "sum", scope: "builtin" as const },
  ];
  const byName = filterCommands(cmds, "rev");
  assert.equal(byName.length, 1);
  assert.equal(byName[0]!.label, "/review");
  const byDesc = filterCommands(cmds, "summarise");
  assert.equal(byDesc.length, 1);
  assert.equal(byDesc[0]!.label, "/compact");
  const all = filterCommands(cmds, "");
  assert.equal(all.length, 3);
});

test("filterSnippets matches alias", () => {
  const snips = [
    { alias: "sig", text: "Best regards", scope: "user" as const },
    { alias: "debug", text: "Debug this", scope: "project" as const },
  ];
  const hits = filterSnippets(snips, "sig");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.label, "#sig");
  const none = filterSnippets(snips, "zzz");
  assert.equal(none.length, 0);
});

test("filterSnippets truncates long text", () => {
  const long = "x".repeat(100);
  const hits = filterSnippets([{ alias: "a", text: long, scope: "user" }], "a");
  assert.ok(hits[0]!.detail.endsWith("…"));
  assert.ok(hits[0]!.detail.length < 60);
});

// ---- pure helper tests: diff parsing ----------------------------------------

test("parseDiffLines classifies additions, deletions, hunks, context", () => {
  const diff = [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -1,3 +1,4 @@",
    " import foo from 'bar';",
    "+import baz from 'qux';",
    " const x = 1;",
    "-const y = 2;",
  ].join("\n");
  const lines = parseDiffLines(diff);
  assert.equal(lines.length, 7);
  assert.equal(lines[0]!.kind, "ctx"); // --- is ctx
  assert.equal(lines[1]!.kind, "ctx"); // +++ is ctx
  assert.equal(lines[2]!.kind, "hunk");
  assert.equal(lines[3]!.kind, "ctx");
  assert.equal(lines[4]!.kind, "add");
  assert.equal(lines[5]!.kind, "ctx");
  assert.equal(lines[6]!.kind, "del");
});

test("parseDiffLines returns empty array for empty string", () => {
  assert.deepEqual(parseDiffLines(""), []);
});

test("multirun events reconstruct runs, output, and pick from the log", () => {
  const m = buildModel([
    ev("multirun/started", {
      multirunId: "mr1",
      prompt: "compare",
      runs: [
        { runId: "r1", model: { providerID: "openai", modelID: "gpt-x" }, agent: "build" },
        { runId: "r2", model: { providerID: "anthropic", modelID: "sonnet" } },
      ],
    }),
    ev("multirun/run-progress", { multirunId: "mr1", runId: "r1", status: "completed", output: "alpha", tokens: { input: 3, output: 4 }, cost: 0.01 }),
    ev("multirun/run-progress", { multirunId: "mr1", runId: "r2", status: "completed", output: "beta" }),
    ev("multirun/completed", { multirunId: "mr1" }),
    ev("multirun/picked", { multirunId: "mr1", runId: "r2" }),
  ]);
  assert.equal(m.multirun?.id, "mr1");
  assert.equal(m.multirun?.prompt, "compare");
  assert.equal(m.multirun?.runs.length, 2);
  assert.equal(m.multirun?.runs[0]?.output, "alpha");
  assert.equal(m.multirun?.runs[1]?.output, "beta");
  assert.equal(m.multirun?.pickedRunId, "r2");
});

test("fusion events reconstruct answer, weights, and disagreements from the log", () => {
  const m = buildModel([
    ev("fusion/started", { fusionId: "f1", prompt: "merge me", models: ["openai/gpt-x", "anthropic/sonnet"] }),
    ev("fusion/completed", {
      fusionId: "f1",
      status: "completed",
      answer: "fused",
      weights: [{ model: "openai/gpt-x", weight: 0.7 }, { model: "anthropic/sonnet", weight: 0.3 }],
      disagreements: ["tone"],
    }),
  ]);
  assert.equal(m.fusionPrompt, "merge me");
  assert.equal(m.fusion?.answer, "fused");
  assert.equal(m.fusion?.weights[0]?.weight, 0.7);
  assert.deepEqual(m.fusion?.disagreements, ["tone"]);
});

test("goalChecklist splits lines and strikes completed items", () => {
  const open = goalChecklist("1. one\n2. two", "active");
  assert.equal(open.length, 2);
  assert.equal(open[0]!.text, "one");
  assert.equal(open[0]!.done, false);
  const done = goalChecklist("- a\n- b", "completed");
  assert.equal(done[1]!.done, true);
});

test("applyTerminalChunk strips CSI, honours CR/BS, and caps buffer", () => {
  assert.equal(applyTerminalChunk("", "hi\x1b[31m!\x1b[0m"), "hi!");
  assert.equal(applyTerminalChunk("abc", "\b\bX"), "aX");
  assert.equal(applyTerminalChunk("one\nxx", "\rYY"), "one\nYY");
});

test("providerColor maps known vendors; modelBadge splits provider/id", () => {
  assert.equal(providerColor("anthropic"), "#f49b5b");
  assert.equal(modelBadge("openai/gpt-4o").label, "gpt-4o");
  assert.equal(modelBadge({ providerID: "xai", modelID: "grok" }).color, "#c4a7ee");
});

// ---- pure helper tests: session title display --------------------------------

test("isPlaceholderTitle flags empty, generic, id-like titles", () => {
  assert.equal(isPlaceholderTitle(""), true);
  assert.equal(isPlaceholderTitle("   "), true);
  assert.equal(isPlaceholderTitle("New session"), true);
  assert.equal(isPlaceholderTitle("Untitled session"), true);
  assert.equal(isPlaceholderTitle("untitled"), true);
  assert.equal(isPlaceholderTitle("ses_01ABCDEF"), true);
  assert.equal(isPlaceholderTitle("3f2a9c1e-77aa-4b1e-9c00-aa11bb22cc33"), true);
  assert.equal(isPlaceholderTitle("deadbeef00"), true);
  assert.equal(isPlaceholderTitle("abc123", "abc123"), true); // equals sessionId
  assert.equal(isPlaceholderTitle("Fix the login bug"), false);
  assert.equal(isPlaceholderTitle("Refactor auth"), false);
});

test("titleFromPrompt takes the first line, collapses whitespace, and caps length", () => {
  assert.equal(titleFromPrompt("Fix the   login\tbug\nmore detail"), "Fix the login bug");
  assert.equal(titleFromPrompt("\n\n  second line is first non-empty  \nrest"), "second line is first non-empty");
  const long = titleFromPrompt("a".repeat(100));
  assert.ok(long.length <= 48);
  assert.ok(long.endsWith("…"));
  assert.equal(titleFromPrompt(""), "");
});

test("displaySessionTitle prefers human title, then prompt, then fallback", () => {
  assert.equal(displaySessionTitle("Refactor auth", "s1"), "Refactor auth");
  assert.equal(displaySessionTitle("", "s1", "Explore the codebase\nplease"), "Explore the codebase");
  assert.equal(displaySessionTitle("s1", "s1", "  "), "New session");
  assert.equal(displaySessionTitle("ses_x", "s1"), "New session");
});

test("ago formats relative times and falls back to a date", () => {
  const now = 1_700_000_000_000;
  assert.equal(ago(now - 10_000, now), "just now");
  assert.equal(ago(now - 5 * 60_000, now), "5m ago");
  assert.equal(ago(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(ago(now - 2 * 86_400_000, now), "2d ago");
  const old = ago(now - 30 * 86_400_000, now);
  assert.ok(!old.endsWith("ago"));
  assert.ok(old.length > 0);
});

// ---- pure helper tests: settings (polyth.settings) ---------------------------

test("parseSettings returns defaults for null, garbage, and non-object JSON", () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings(""), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings("not json"), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings("42"), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings("null"), DEFAULT_SETTINGS);
});

test("parseSettings merges partial stored values over defaults", () => {
  const s = parseSettings(JSON.stringify({ theme: "light", fontSize: 16 }));
  assert.equal(s.theme, "light");
  assert.equal(s.fontSize, 16);
  assert.equal(s.density, DEFAULT_SETTINGS.density);
  assert.equal(s.sendOnEnter, DEFAULT_SETTINGS.sendOnEnter);
  assert.equal(s.productName, DEFAULT_SETTINGS.productName);
});

test("normalizeSettings clamps and validates every field", () => {
  const s = normalizeSettings({
    theme: "hotdog",
    density: "cozy",
    fontSize: 99,
    productName: "   ",
    relativeTime: "yes",
    defaultModel: 7,
  });
  assert.equal(s.theme, "dark");
  assert.equal(s.density, "comfortable");
  assert.equal(s.fontSize, 18); // clamped to max
  assert.equal(s.productName, "Polyth"); // blank falls back
  assert.equal(s.relativeTime, DEFAULT_SETTINGS.relativeTime); // non-boolean ignored
  assert.equal(s.defaultModel, ""); // non-string ignored
  assert.equal(normalizeSettings({ fontSize: 1 }).fontSize, 12); // clamped to min
});

test("settings round-trip: serialize then parse is identity", () => {
  const custom = {
    ...DEFAULT_SETTINGS,
    theme: "light" as const,
    density: "compact" as const,
    fontSize: 15,
    productName: "MyPolyth",
    sendOnEnter: false,
    defaultModel: "anthropic/claude-x",
    showArchived: false,
  };
  assert.deepEqual(parseSettings(serializeSettings(custom)), custom);
});

test("parseModelRef splits provider/model at the first slash", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-x"), { providerID: "anthropic", modelID: "claude-x" });
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude"), { providerID: "openrouter", modelID: "anthropic/claude" });
  assert.equal(parseModelRef(""), undefined);
  assert.equal(parseModelRef("no-slash"), undefined);
  assert.equal(parseModelRef("/leading"), undefined);
  assert.equal(parseModelRef("trailing/"), undefined);
  assert.equal(formatModelRef({ providerID: "a", modelID: "b" }), "a/b");
});

// ---- pure helper tests: friendly error messages -------------------------------

test("friendlyError collapses transport failures into the reconnect message", () => {
  const expected = "OpenCode is reconnecting. Try again in a moment.";
  assert.equal(friendlyError("Couldn’t create a session", new Error("HTTP 500 Internal Server Error — fetch failed")), expected);
  assert.equal(friendlyError("x", new Error("HTTP 503 Service Unavailable — {}")), expected);
  assert.equal(friendlyError("x", new Error("backend unavailable")), expected);
  assert.equal(friendlyError("x", new Error("connect ECONNREFUSED 127.0.0.1:4096")), expected);
});

test("friendlyError extracts the server's JSON error body", () => {
  const err = new Error('HTTP 500 Internal Server Error — {"error":"worktree is locked"}');
  assert.equal(
    friendlyError("Couldn’t fork the session", err),
    "Couldn’t fork the session: HTTP 500 Internal Server Error — worktree is locked",
  );
});

test("modKeyLabel and shortcutLabel fall back to Ctrl without a DOM", () => {
  assert.equal(modKeyLabel(), "Ctrl");
  assert.equal(shortcutLabel("K"), "Ctrl+K");
});

test("friendlyError truncates long raw messages and keeps the action prefix", () => {
  const long = new Error(`HTTP 500 Oops — ${"x".repeat(500)}`);
  const msg = friendlyError("Couldn’t send the message", long);
  assert.ok(msg.startsWith("Couldn’t send the message: "));
  assert.ok(msg.length < 220);
  assert.equal(friendlyError("Couldn’t archive the session", "plain string"), "Couldn’t archive the session: plain string");
});