// DOM-free smoke tests for the web render pipeline: reducer, sync dedupe, slots, goal, utils.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel, emptyModel, reduceEvent, type GoalState } from "../src/reduce.ts";
import { createSeqDedupe } from "../src/sync.ts";
import { registerSlot, listSlots, renderSlot } from "../src/slots.ts";
import {
  applyTerminalChunk,
  copyText,
  diffStat,
  filterCommands,
  filterSnippets,
  firstUserText,
  goalChecklist,
  groupWork,
  loadDraft,
  parseDiffLines,
  saveDraft,
  toolSummary,
} from "../src/utils.ts";
import { drainInserts, queueInsert, requestComposerInsert } from "../src/composerInsert.ts";
import { ago, deriveSessionTitle, fmtDuration, fmtMs, fullSessionTitle, modKey, modelBadge, providerColor } from "../src/format.ts";
import { applyPersona, getPrefs, isCustomized, parsePrefs, pluginOn, togglePlugin } from "../src/prefs.ts";
import { filterPalette, type PaletteCommand } from "../src/commands.ts";
import { highlight, highlightLines, langOf } from "../src/highlight.ts";
import { PATH_MIME, dragKind, getDragPath, setDragPath } from "../src/dnd.ts";
import { formatFileChat, formatSelectionChat, lineRangeOf } from "../src/chatclip.ts";
import { filterPickerItems, type PickerItem } from "../src/picker.ts";
import { MODEL_PREFS_KEY, parseModelPrefs } from "@polyth/models";
import { getModelPrefs, noteModelUsed, setModelSort, toggleModelFavorite } from "../src/modelPrefs.ts";
import {
  UI_DEFAULTS,
  UI_SETTINGS_KEY,
  applyUiSettings,
  getUiSettings,
  parseUiSettings,
  setUiSettings,
} from "../src/uiPrefs.ts";
import { normalizeScheduleList } from "../src/scheduleData.ts";
import { agentPickerDefaultLabel, modelPickerDefaultLabel } from "../src/composerDefaults.ts";

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

test("applyPersona enables the expected plugins for every persona", () => {
  const expected = {
    engineer: ["session", "files", "git", "preview", "terminal", "context", "usage", "events", "goals", "multirun", "fusion", "walkthrough", "schedule", "github", "dictation", "knowledge"],
    manager: ["session", "files", "context", "usage", "goals", "multirun", "fusion", "walkthrough", "knowledge"],
    creator: ["session", "preview", "files"],
    blank: ["session", "files", "context", "usage"],
  } as const;

  for (const persona of ["engineer", "manager", "creator", "blank"] as const) {
    applyPersona(persona);
    assert.equal(getPrefs().persona, persona);
    assert.deepEqual(getPrefs().plugins, expected[persona]);
  }
});

test("togglePlugin keeps session enabled and adds or removes git", () => {
  applyPersona("creator");
  assert.equal(pluginOn("session"), true);
  assert.equal(pluginOn("git"), false);

  togglePlugin("session");
  assert.equal(pluginOn("session"), true);

  togglePlugin("git");
  assert.equal(pluginOn("git"), true);
  togglePlugin("git");
  assert.equal(pluginOn("git"), false);
});

test("pluginOn reflects the currently enabled persona plugins", () => {
  applyPersona("manager");
  assert.equal(pluginOn("goals"), true);
  assert.equal(pluginOn("git"), false);
});

test("parsePrefs restores persona, drops unknown plugins, and fills empty lists", () => {
  const restored = parsePrefs(JSON.stringify({
    persona: "engineer",
    plugins: ["session", "git", "schedule", "github", "dictation", "nope"],
  }));
  assert.equal(restored.persona, "engineer");
  assert.deepEqual(restored.plugins, ["session", "git", "schedule", "github", "dictation"]);
  assert.deepEqual(parsePrefs("not-json"), { persona: null, plugins: [] });
  const creator = parsePrefs(JSON.stringify({ persona: "creator", plugins: [] }));
  assert.equal(creator.persona, "creator");
  assert.deepEqual(creator.plugins, ["session", "preview", "files"]);
});

test("model preference wrapper updates and persists favorites, sort, and recents", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
    },
  });
  const key = "test-provider/test-model";
  if (getModelPrefs().favorites.includes(key)) toggleModelFavorite(key);

  toggleModelFavorite(key);
  noteModelUsed("other/model");
  noteModelUsed(key);
  setModelSort("recent");

  assert.equal(getModelPrefs().favorites.includes(key), true);
  assert.deepEqual(getModelPrefs().recents.slice(0, 2), [key, "other/model"]);
  assert.equal(getModelPrefs().sort, "recent");
  assert.deepEqual(parseModelPrefs(values.get(MODEL_PREFS_KEY) ?? null), getModelPrefs());
});

test("parseUiSettings defaults invalid values and sanitizes MCP servers", () => {
  assert.deepEqual(parseUiSettings(null), UI_DEFAULTS);
  assert.deepEqual(parseUiSettings("not-json"), UI_DEFAULTS);
  const servers = Array.from({ length: 35 }, (_, i) => ({ name: `server-${i}`, url: `https://mcp/${i}` }));
  const parsed = parseUiSettings(JSON.stringify({
    density: "compact",
    fontSize: "l",
    chatWidth: "wide",
    reducedMotion: true,
    notifyOnComplete: true,
    notifySound: "yes",
    confirmSessionArchive: true,
    autoScroll: false,
    mcpServers: [null, { name: 1, url: "bad" }, ...servers],
  }));

  assert.deepEqual(
    {
      density: parsed.density,
      fontSize: parsed.fontSize,
      chatWidth: parsed.chatWidth,
      reducedMotion: parsed.reducedMotion,
      notifyOnComplete: parsed.notifyOnComplete,
      notifySound: parsed.notifySound,
      confirmSessionArchive: parsed.confirmSessionArchive,
      autoScroll: parsed.autoScroll,
    },
    {
      density: "compact",
      fontSize: "l",
      chatWidth: "wide",
      reducedMotion: true,
      notifyOnComplete: true,
      notifySound: false,
      confirmSessionArchive: true,
      autoScroll: false,
    },
  );
  assert.equal(parsed.mcpServers.length, 32);
  assert.deepEqual(parsed.mcpServers[0], servers[0]);
});

test("setUiSettings persists and applies visual data attributes", () => {
  const values = new Map<string, string>();
  const dataset: Record<string, string> = {};
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body: { dataset } },
  });

  setUiSettings({ density: "compact", fontSize: "s", chatWidth: "wide", reducedMotion: true });
  assert.deepEqual(dataset, {
    density: "compact",
    fontsize: "s",
    chatwidth: "wide",
    motion: "reduced",
  });
  assert.deepEqual(parseUiSettings(values.get(UI_SETTINGS_KEY) ?? null), getUiSettings());

  Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
  assert.doesNotThrow(() => applyUiSettings());
});

test("filterPalette matches label, id, and group case-insensitively", () => {
  const commands: PaletteCommand[] = [
    { id: "session.new", label: "New Session", group: "Workspace", run() {} },
    { id: "settings.open", label: "Preferences", group: "Account", run() {} },
    { id: "git.commit", label: "Create commit", group: "Source Control", run() {} },
  ];

  assert.deepEqual(filterPalette(commands, " SESSION ").map((c) => c.id), ["session.new"]);
  assert.deepEqual(filterPalette(commands, "settings").map((c) => c.id), ["settings.open"]);
  assert.deepEqual(filterPalette(commands, "source control").map((c) => c.id), ["git.commit"]);
  assert.equal(filterPalette(commands, ""), commands);
  assert.deepEqual(filterPalette(commands, "missing"), []);
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

test("rewind collapses its target tail, redo restores it, replacement keeps it hidden", () => {
  const events = [
    ev("user/message", { text: "first" }),
    ev("assistant/message", { partId: "a1", text: "one" }),
    ev("user/message", { text: "second" }),
    ev("assistant/message", { partId: "a2", text: "two" }),
  ];
  const targetSeq = events[2]!.seq;
  const marker = ev("session/rewound", { atSeq: targetSeq, restoredText: "second" });
  const rewound = buildModel([...events, marker]);
  assert.deepEqual(rewound.messages.filter((message) => !message.undone).map((message) => message.id), [
    events[0]!.id,
    "a1",
  ]);
  assert.deepEqual(rewound.messages.filter((message) => message.undone).map((message) => message.id), [
    events[2]!.id,
    "a2",
  ]);
  assert.deepEqual(rewound.rewind, { markerSeq: marker.seq, atSeq: targetSeq, restoredText: "second" });

  const redone = reduceEvent(rewound, ev("session/rewind-cleared", { rewindSeq: marker.seq }));
  assert.equal(redone.rewind, null);
  assert.equal(redone.messages.some((message) => message.undone), false);

  const replacedBase = buildModel([...events, marker]);
  const replaced = reduceEvent(
    replacedBase,
    ev("session/rewind-cleared", { rewindSeq: marker.seq, replaced: true }),
  );
  reduceEvent(replaced, ev("user/message", { text: "replacement" }));
  assert.equal(replaced.messages.filter((message) => message.undone).length, 2);
  assert.equal(replaced.messages.at(-1)?.undone, undefined);
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

test("diffStat excludes diff headers from added and removed counts", () => {
  const diff = "--- a/file.ts\n+++ b/file.ts\n-old\n+new\n context";
  assert.deepEqual(diffStat(diff), { add: 1, del: 1 });
});

test("toolSummary selects a useful argument and truncates long values", () => {
  assert.equal(toolSummary({ path: "src/App.tsx", query: "ignored" }), "src/App.tsx");
  assert.equal(toolSummary({ count: 2 }), "");
  const summary = toolSummary({ command: "x".repeat(200) });
  assert.equal(summary, `${"x".repeat(157)}…`);
});

test("groupWork groups consecutive tools and computes elapsed time", () => {
  const messages = [
    { kind: "tool" as const, id: "a", callId: "a", eventSeq: 1, tool: "read", input: {}, status: "done" as const, time: 100, finishTime: 250 },
    { kind: "tool" as const, id: "b", callId: "b", eventSeq: 2, tool: "write", input: {}, status: "done" as const, time: 260, finishTime: 375 },
    { kind: "user" as const, id: "u", eventSeq: 3, text: "next", time: 400 },
  ];
  const grouped = groupWork(messages);
  const work = grouped[0];
  assert.ok(work && work.kind === "work");
  assert.equal(work.ms, 275);
  assert.deepEqual(work.tools, messages.slice(0, 2));
  assert.equal(grouped[1], messages[2]);

  const loneTool = groupWork(messages.slice(0, 1));
  assert.equal(loneTool[0], messages[0]);
});

test("draft helpers persist per session and remove empty drafts", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    },
  });

  saveDraft("s1", "unfinished");
  saveDraft("s2", "other");
  assert.equal(loadDraft("s1"), "unfinished");
  assert.equal(loadDraft("s2"), "other");
  saveDraft("s1", "");
  assert.equal(loadDraft("s1"), "");
  assert.equal(values.has("polyth.draft.s1"), false);
});

test("fmtMs formats elapsed milliseconds and seconds", () => {
  assert.equal(fmtMs(999), "999ms");
  assert.equal(fmtMs(1_250), "1.3s");
});

test("fmtDuration formats elapsed wall-clock spans", () => {
  assert.equal(fmtDuration(-1), "0s");
  assert.equal(fmtDuration(45_600), "46s");
  assert.equal(fmtDuration(181_000), "3m 1s");
  assert.equal(fmtDuration(3_840_000), "1h 4m");
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

// ---- highlight tokenizer ------------------------------------------------------

test("highlight wraps kw/str/cmt/num in spans and escapes HTML", () => {
  const html = highlight('const n = 42; // note\nconst s = "<b>";', "ts");
  assert.ok(html.includes('<span class="tok-kw">const</span>'));
  assert.ok(html.includes('<span class="tok-num">42</span>'));
  assert.ok(html.includes('<span class="tok-cmt">// note</span>'));
  assert.ok(html.includes('<span class="tok-str">"&lt;b&gt;"</span>'));
  assert.ok(!html.includes("<b>"));
});

test("highlight uses hash comments for py/sh/yaml and html comments for md", () => {
  assert.ok(highlight("# hi", "py").includes('<span class="tok-cmt"># hi</span>'));
  assert.ok(highlight("# hi", "sh").includes("tok-cmt"));
  assert.ok(highlight("<!-- x -->", "md").includes("tok-cmt"));
  assert.ok(highlight('key: "v" # c', "yaml").includes("tok-str"));
});

test("langOf maps extensions and aliases", () => {
  assert.equal(langOf("src/App.tsx"), "ts");
  assert.equal(langOf("a/b.yml"), "yaml");
  assert.equal(langOf("main.rs"), "rs");
});

test("highlightLines splits highlighted code into self-contained line HTML", () => {
  const lines = highlightLines("const a = 1;\nconst b = 2;", "ts");
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes('<span class="tok-kw">const</span>'));
  assert.ok(lines[1]!.includes('<span class="tok-num">2</span>'));
});

test("highlightLines reopens tokens that span newlines", () => {
  const lines = highlightLines("/* a\nb */ x", "ts");
  assert.equal(lines.length, 2);
  // The block comment closes at the break and reopens on the next line.
  assert.ok(lines[0]!.endsWith("</span>"));
  assert.ok(lines[1]!.startsWith('<span class="tok-cmt">'));
  assert.equal(highlightLines("", "ts").length, 1);
});

// ---- dnd helpers --------------------------------------------------------------

test("dnd path mime helpers set and read the polyth path", () => {
  const data = new Map<string, string>();
  const dt = {
    setData: (t: string, v: string) => void data.set(t, v),
    getData: (t: string) => data.get(t) ?? "",
  };
  setDragPath(dt, "src/app.ts");
  assert.equal(data.get(PATH_MIME), "src/app.ts");
  assert.equal(data.get("text/plain"), "@src/app.ts");
  assert.equal(getDragPath(dt), "src/app.ts");
  assert.equal(getDragPath({ ...dt, getData: () => "" }), null);
});

test("dragKind detects polyth paths, desktop files, or nothing", () => {
  assert.equal(dragKind({ types: [PATH_MIME, "text/plain"] }), "path");
  assert.equal(dragKind({ types: ["Files"] }), "files");
  assert.equal(dragKind({ types: ["text/html"] }), null);
});

test("formatSelectionChat includes the file, line range, and fenced selection", () => {
  assert.equal(
    formatSelectionChat("src/view.tsx", "<Button>\n  Save\n</Button>", 12, 14),
    "@src/view.tsx (lines 12-14)\n```\n<Button>\n  Save\n</Button>\n```",
  );
});

test("formatFileChat fences small files and omits oversized content", () => {
  assert.equal(
    formatFileChat("src/tiny.ts", "export {};\n", 11),
    "@src/tiny.ts\n```\nexport {};\n```",
  );
  assert.equal(formatFileChat("src/large.ts", "12345", 4), "@src/large.ts");
});

test("lineRangeOf maps character offsets to 1-based line ranges", () => {
  const content = "one\ntwo\nthree";
  assert.deepEqual(lineRangeOf(content, 0, 3), { startLine: 1, endLine: 1 });
  assert.deepEqual(lineRangeOf(content, 4, 7), { startLine: 2, endLine: 2 });
  assert.deepEqual(lineRangeOf(content, 0, content.length), { startLine: 1, endLine: 3 });
  // A selection ending exactly on a newline does not reach the next line.
  assert.deepEqual(lineRangeOf(content, 0, 4), { startLine: 1, endLine: 1 });
  // Clamped: offsets beyond the content never produce out-of-range lines.
  assert.deepEqual(lineRangeOf(content, 50, 99), { startLine: 3, endLine: 3 });
  assert.deepEqual(lineRangeOf("", 0, 0), { startLine: 1, endLine: 1 });
});

// ---- UX fix-list helpers ------------------------------------------------------

test("ago formats compact relative times", () => {
  const now = 1_700_000_000_000;
  assert.equal(ago(now - 5_000, now), "5s");
  assert.equal(ago(now - 3 * 60_000, now), "3m");
  assert.equal(ago(now - 6 * 3_600_000, now), "6h");
  assert.equal(ago(now - 2 * 86_400_000, now), "2d");
  assert.equal(ago(now + 10_000, now), "0s"); // clock skew never goes negative
});

test("modKey picks ⌘ on Apple platforms, Ctrl elsewhere", () => {
  assert.equal(modKey("MacIntel"), "⌘");
  assert.equal(modKey("iPhone"), "⌘");
  assert.equal(modKey("Win32"), "Ctrl");
  assert.equal(modKey(""), "Ctrl");
});

test("deriveSessionTitle replaces placeholders with the first user line", () => {
  assert.equal(deriveSessionTitle("Real title", "hello"), "Real title");
  assert.equal(deriveSessionTitle("New session", "Fix the login bug\nmore"), "Fix the login bug");
  assert.equal(deriveSessionTitle("", "  \n  second line  "), "second line");
  assert.equal(deriveSessionTitle("(untitled)", undefined), "(untitled)");
  const long = "x".repeat(60);
  const derived = deriveSessionTitle("new session", long);
  assert.equal(derived.length, 48);
  assert.ok(derived.endsWith("…"));
});

test("fullSessionTitle preserves the complete derived title for tooltips", () => {
  const full = "Investigate the unusually long authentication regression before release";
  assert.equal(fullSessionTitle("New session", full), full);
  assert.notEqual(deriveSessionTitle("New session", full), full);
});

test("schedule list normalization accepts arrays and wrapped payloads", () => {
  const task = {
    id: "task-1",
    projectId: "project-1",
    prompt: "Check CI",
    kind: "every" as const,
    cadence: { kind: "every" as const, everyMinutes: 15 },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2,
    runs: 0,
  };
  assert.deepEqual(normalizeScheduleList([task]), { tasks: [task], loopErrors: [] });
  assert.deepEqual(
    normalizeScheduleList({ tasks: [task], loopErrors: [{ path: ".agents/loops/ci.md", error: "bad cron" }] }),
    { tasks: [task], loopErrors: [{ path: ".agents/loops/ci.md", error: "bad cron" }] },
  );
  assert.deepEqual(normalizeScheduleList({ tasks: null }), { tasks: [], loopErrors: [] });
});

test("composer defaults show resolved model and agent names", () => {
  const models = [
    { providerID: "google", modelID: "gemini-2", name: "Gemini Pro" },
    { providerID: "openai", modelID: "gpt-5", name: "GPT 5" },
  ];
  const agents = [{ name: "build", mode: "primary" as const }];
  assert.equal(modelPickerDefaultLabel(undefined, models), "Default: Gemini Pro");
  assert.equal(modelPickerDefaultLabel({ providerID: "openai", modelID: "gpt-5" }, models), "GPT 5");
  assert.equal(agentPickerDefaultLabel(undefined, agents), "Default: build");
});

test("firstUserText finds the first non-empty user message", () => {
  const events = [
    ev("turn/started", { turnId: "t1" }),
    ev("user/message", { text: "   " }),
    ev("user/message", { text: "actual question" }),
  ];
  // First user/message wins even when blank → undefined, so blank logs fall back.
  assert.equal(firstUserText(events), undefined);
  assert.equal(firstUserText([ev("user/message", { text: "hi" })]), "hi");
  assert.equal(firstUserText(undefined), undefined);
  assert.equal(firstUserText([]), undefined);
});

test("copyText reports success and failure via injected clipboard", async () => {
  let copied = "";
  assert.equal(await copyText("abc", { writeText: async (t) => void (copied = t) }), true);
  assert.equal(copied, "abc");
  assert.equal(await copyText("abc", { writeText: async () => { throw new Error("denied"); } }), false);
});

test("composer insert queue holds inserts until drained", () => {
  drainInserts(); // isolate
  queueInsert("@src/a.ts ");
  queueInsert("@src/b.ts ");
  assert.deepEqual(drainInserts(), ["@src/a.ts ", "@src/b.ts "]);
  assert.deepEqual(drainInserts(), []);
});

test("requestComposerInsert queues when no composer consumes the event", () => {
  drainInserts();
  // Node has no window: the insert must land in the queue, not vanish.
  assert.equal(requestComposerInsert("@x.ts "), false);
  assert.deepEqual(drainInserts(), ["@x.ts "]);
});

test("isCustomized flags plugin sets that drift from persona defaults", () => {
  applyPersona("creator");
  assert.equal(isCustomized(), false);
  togglePlugin("git");
  assert.equal(isCustomized(), true);
  togglePlugin("git");
  assert.equal(isCustomized(), false);
  assert.equal(isCustomized({ persona: null, plugins: [] }), false);
});

test("filterPickerItems handles empty and case-insensitive grouped searches", () => {
  const items: PickerItem[] = [
    { id: "file.app", label: "App.tsx", group: "Files", detail: "src/App.tsx" },
    { id: "command.commit", label: "Create commit", group: "Source Control" },
    { id: "session.new", label: "New session", group: "Workspace", keywords: ["Start"] },
  ];

  assert.deepEqual(filterPickerItems(items, "  "), items);
  assert.deepEqual(filterPickerItems(items, "SOURCE"), [items[1]]);
  assert.deepEqual(filterPickerItems(items, "app.TSX"), [items[0]]);
  assert.deepEqual(filterPickerItems(items, "start"), [items[2]]);
  assert.deepEqual(filterPickerItems(items, "missing"), []);
});