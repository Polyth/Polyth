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
import { parsePrefs } from "../src/prefs.ts";
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
import { extractChangedFiles, selectPendingChanges } from "../src/pendingChanges.ts";
import { sessionSurfaceKind, type SurfaceModel } from "../src/sessionSurface.ts";
import { mergeThinking } from "../src/utils.ts";
import {
  JUMP_TO_LATEST_NAME,
  OPEN_TIMELINE_NAME,
  PROMPT_NAV_NAME,
  assistantArticleName,
  assistantTime,
  boundedPromptPreview,
  copyActionName,
  copyAnnouncement,
  copyJson,
  copyMarkdown,
  draftStateOf,
  forkActionName,
  forkAvailability,
  forkSeedKey,
  guardsFromModel,
  mutationErrorMessage,
  normalizedDuration,
  promptJumpName,
  reasoningToggleName,
  revertActionName,
  revertAvailability,
  rewindSeedKey,
  shouldApplySeed,
  timeIso,
  timeShort,
  turnDurationMs,
  turnFooterLine,
  userArticleName,
} from "../src/messageActions.ts";

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

test("edit tool results derive changed files and a new prompt clears the turn summary", () => {
  const model = buildModel([
    ev("tool/call", { callId: "read", tool: "read_file", input: { path: "src/read.ts" } }),
    ev("tool/result", { callId: "read", tool: "read_file", output: "ok" }),
    ev("tool/call", { callId: "write", tool: "apply_patch", input: {
      patchText: "*** Update File: src/a.ts\n*** Add File: src/b.ts",
    } }),
    ev("tool/result", {
      callId: "write",
      tool: "apply_patch",
      output: "done",
      metadata: { files: ["src/b.ts", "src/c.ts"] },
    }),
  ]);
  assert.deepEqual(model.changedFiles, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  const write = model.messages.find((message) => message.kind === "tool" && message.callId === "write");
  assert.deepEqual(write?.kind === "tool" ? write.changedFiles : undefined, model.changedFiles);

  reduceEvent(model, ev("user/message", { text: "next turn" }));
  assert.deepEqual(model.changedFiles, []);
});

test("pending-change source prefers authoritative git status and dedupes file paths", () => {
  assert.deepEqual(extractChangedFiles("read_file", { path: "src/a.ts" }), []);
  assert.deepEqual(extractChangedFiles("write", { filePath: "./src/a.ts" }, { changedFiles: ["src/a.ts", "src/b.ts"] }), [
    "src/a.ts",
    "src/b.ts",
  ]);
  const status = {
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: [{ path: "src/a.ts", status: "modified", staged: true }],
    unstaged: [{ path: "src/a.ts", status: "modified", staged: false }],
    untracked: [{ path: "src/new.ts", status: "untracked", staged: false }],
    conflicted: [],
  };
  assert.deepEqual(selectPendingChanges(status, ["fallback.ts"]), {
    source: "git",
    paths: ["src/a.ts", "src/new.ts"],
  });
  assert.deepEqual(selectPendingChanges({ ...status, staged: [], unstaged: [], untracked: [] }, ["fallback.ts"]), {
    source: "git",
    paths: [],
  });
  assert.deepEqual(selectPendingChanges(null, ["fallback.ts", "./fallback.ts"]), {
    source: "tools",
    paths: ["fallback.ts"],
  });
});

test("task snapshot revisions derive ordered semantic activity exactly once", () => {
  const model = buildModel([
    ev("task/snapshot", {
      listId: "todo",
      revision: 1,
      items: [
        { id: "a", text: "Inspect", status: "pending" },
        { id: "b", text: "Build", status: "active" },
      ],
    }),
    ev("task/snapshot", {
      listId: "todo",
      revision: 2,
      items: [
        { id: "a", text: "Inspect", status: "active" },
        { id: "b", text: "Build", status: "done" },
      ],
    }),
    ev("task/snapshot", {
      listId: "todo",
      revision: 2,
      items: [{ id: "a", text: "duplicate", status: "done" }],
    }),
    ev("task/snapshot", {
      listId: "todo",
      revision: 3,
      items: [
        { id: "a", text: "Inspect", status: "active" },
        { id: "b", text: "Build", status: "done" },
      ],
    }),
  ]);
  const activities = model.messages.filter((message) => message.kind === "task");
  assert.deepEqual(activities.map((activity) => [activity.action, activity.text]), [
    ["created", "Inspect"],
    ["started", "Build"],
    ["started", "Inspect"],
    ["completed", "Build"],
  ]);
  assert.equal(new Set(activities.map((activity) => activity.id)).size, activities.length);
  assert.equal(model.tasks?.revision, 3);
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

test("secret/requested adds a pending credential handle and secret/resolved clears it", () => {
  const requested = ev("secret/requested", {
    requestId: "secret-1",
    handle: "deploy-token",
    label: "Deployment token",
    purpose: "Publish releases",
    kind: "token",
    existing: true,
  });
  const model = buildModel([requested]);

  assert.deepEqual(model.secrets, [{
    requestId: "secret-1",
    handle: "deploy-token",
    label: "Deployment token",
    purpose: "Publish releases",
    kind: "token",
    existing: true,
    status: "pending",
    time: requested.time,
  }]);

  reduceEvent(model, ev("secret/resolved", {
    requestId: "secret-1",
    action: "saved",
    handle: "deploy-token",
  }));
  assert.equal(model.secrets[0]?.status, "resolved");
  assert.equal(model.secrets[0]?.action, "saved");
  assert.equal(model.secrets.filter((secret) => secret.status === "pending").length, 0);
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
    ev("secret/requested", { requestId: "secret-1", handle: "token", label: "Token" }),
    ev("secret/resolved", { requestId: "secret-1", action: "dismissed" }),
    ev("usage/recorded", { model: { providerID: "anthropic", modelID: "claude-x" }, tokens: { input: 3, output: 7 }, cost: 0.01 }),
    ev("turn/stopped", { turnId: "t1", reason: "completed" }),
  ];
  const a = buildModel(events);
  const b = events.reduce(reduceEvent, emptyModel());
  assert.deepEqual(a.messages, b.messages);
  assert.deepEqual(a.permissions, b.permissions);
  assert.deepEqual(a.secrets, b.secrets);
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
    rounding: "rounded",
    chatWidth: "wide",
    notifyOnComplete: true,
    notifySound: "yes",
    confirmSessionArchive: true,
    autoScroll: false,
    showMessageActions: false,
    messageCopyFormat: "json",
    mcpServers: [null, { name: 1, url: "bad" }, ...servers],
  }));

  assert.deepEqual(
    {
      density: parsed.density,
      fontSize: parsed.fontSize,
      rounding: parsed.rounding,
      chatWidth: parsed.chatWidth,
      notifyOnComplete: parsed.notifyOnComplete,
      notifySound: parsed.notifySound,
      confirmSessionArchive: parsed.confirmSessionArchive,
      autoScroll: parsed.autoScroll,
      showMessageActions: parsed.showMessageActions,
      messageCopyFormat: parsed.messageCopyFormat,
    },
    {
      density: "compact",
      fontSize: "l",
      rounding: "rounded",
      chatWidth: "wide",
      notifyOnComplete: true,
      notifySound: false,
      confirmSessionArchive: true,
      autoScroll: false,
      showMessageActions: false,
      messageCopyFormat: "json",
    },
  );
  assert.equal(parsed.mcpServers.length, 32);
  assert.deepEqual(parsed.mcpServers[0], servers[0]);
  assert.equal(parseUiSettings(JSON.stringify({ messageCopyFormat: "xml" })).messageCopyFormat, "markdown");
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

  setUiSettings({ density: "compact", fontSize: "s", rounding: "rounded", chatWidth: "wide" });
  assert.deepEqual(dataset, {
    density: "compact",
    rounding: "rounded",
    chatwidth: "wide",
    technical: "true",
    dictate: "true",
    quickActions: "true",
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

test("goal stop clears the active projection so a replacement can be attached", () => {
  let m = buildModel([
    ev("goal/attached", { objective: "Deploy" }),
    ev("goal/stuck", {}),
  ]);
  assert.equal(m.goal!.status, "stuck");
  m = reduceEvent(m, ev("goal/stopped", {}));
  assert.equal(m.goal, null);
  m = reduceEvent(m, ev("goal/attached", { objective: "Deploy replacement" }));
  assert.equal(m.goal?.objective, "Deploy replacement");
  assert.equal(m.goal?.status, "active");
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
  // UX-MSG-ACTIONS: the composer seed is replay-derived from the target
  // user/message (raw ?? text); legacy restoredText stays readable.
  assert.deepEqual(rewound.rewind, {
    markerSeq: marker.seq,
    atSeq: targetSeq,
    restoredText: "second",
    draft: { text: "second" },
  });

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

  const withTask = groupWork([
    messages[0]!,
    { kind: "task", id: "task-1", taskId: "1", eventSeq: 2, text: "Build", action: "started", time: 200 },
  ]);
  const taskGroup = withTask[0];
  assert.ok(taskGroup && taskGroup.kind === "work");
  assert.equal(taskGroup.tools.length, 1);
  assert.equal(taskGroup.tasks[0]?.action, "started");
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

// ---- UX-MSG-ACTIONS: timing, seeds, fork lineage, reasoning, copy ------------

test("turn footer uses one terminal turn's own start/stop and usage with normalized carry", () => {
  const events = [
    ev("user/message", { text: "go" }),
    ev("turn/started", { turnId: "t1", model: { providerID: "p", modelID: "m" } }),
    ev("assistant/message", { partId: "p1", text: "done" }),
    ev("usage/recorded", { tokens: { input: 1200, output: 300 }, cost: 0.01 }),
    ev("turn/stopped", { turnId: "t1", reason: "completed" }),
  ];
  // Force a 299.6s wall clock between start and stop (the "4m 60s" trap).
  events[1]!.time = 1_000_000;
  events[4]!.time = 1_000_000 + 299_600;
  const m = buildModel(events);
  assert.equal(m.turn?.startedAt, 1_000_000);
  assert.equal(m.turn?.stoppedAt, 1_000_000 + 299_600);
  assert.equal(normalizedDuration(299_600), "5m 0s"); // never "4m 60s"
  assert.deepEqual(m.turn?.usage, { tokens: { input: 1200, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 });
  const line = turnFooterLine(m);
  assert.ok(line);
  assert.match(line!, /worked 5m 0s/);
  assert.match(line!, /1\.2k in · 300 out/);
});

test("an unmatched copied stop yields no duration and inherited totals never leak into the footer turn", () => {
  // A branch child log that (hypothetically) carried a stop without a start:
  const m = buildModel([
    ev("user/message", { text: "seed" }),
    ev("turn/stopped", { turnId: "ghost", reason: "completed" }),
  ]);
  assert.equal(turnDurationMs(m.turn), null);
  const line = turnFooterLine(m);
  assert.equal(line === null || !/worked/.test(line), true); // no "worked 0s"
  // Working turns render no footer at all.
  const working = buildModel([ev("turn/started", { turnId: "t" })]);
  assert.equal(turnFooterLine(working), null);
});

test("assistant completion time is the final assistant/message time, not the first chunk", () => {
  const chunk = ev("assistant/chunk", { partId: "pt", text: "he" });
  const fin = ev("assistant/message", { partId: "pt", text: "hello" });
  chunk.time = 5_000;
  fin.time = 9_000;
  const m = buildModel([chunk, fin]);
  const a = m.messages[0];
  assert.ok(a && a.kind === "assistant");
  if (a.kind === "assistant") {
    assert.equal(a.time, 5_000); // stream anchor unchanged
    assert.equal(a.completedAt, 9_000);
    assert.equal(assistantTime(a), 9_000);
  }
});

test("session/forked marker owns the child draft and a child prompt consumes the seed exactly once", () => {
  const prefix = [
    ev("user/message", { text: "turn one" }),
    ev("assistant/message", { partId: "f1", text: "answer one" }),
  ];
  const marker = ev("session/forked", {
    fromSessionId: "source-1",
    sourceAtSeq: 42,
    copiedThroughSeq: 41,
    draft: { text: "excluded prompt", attachments: [] },
  });
  const m = buildModel([...prefix, marker]);
  assert.deepEqual(m.fork, {
    fromSessionId: "source-1",
    markerSeq: marker.seq,
    sourceAtSeq: 42,
    draft: { text: "excluded prompt" },
    seedConsumed: false,
  });
  // The excluded prompt is NOT in the child timeline (draft only).
  assert.equal(m.messages.filter((x) => x.kind === "user").length, 1);
  // A child-origin prompt after the marker flips seedConsumed; replay agrees.
  const sent = reduceEvent(m, ev("user/message", { text: "excluded prompt" }));
  assert.equal(sent.fork?.seedConsumed, true);
  const replayed = buildModel([...prefix, marker, ev("user/message", { text: "again" })]);
  assert.equal(replayed.fork?.seedConsumed, true);
});

test("copied fork events keep their source times through the reducer", () => {
  const u = ev("user/message", { text: "original" });
  u.time = 123_456_789;
  const m = buildModel([u]);
  assert.equal(m.messages[0]?.time, 123_456_789);
});

test("full replay and incremental reduction are deeply equal for messages, reasoning, tail, turn, and usage", () => {
  const events = [
    ev("user/message", { text: "one" }),
    ev("turn/started", { turnId: "t1" }),
    ev("assistant/reasoning-chunk", { partId: "r1", text: "hmm " }),
    ev("assistant/message", { partId: "r1", text: "", reasoning: "hmm done" }),
    ev("assistant/chunk", { partId: "a1", text: "ans" }),
    ev("assistant/message", { partId: "a1", text: "answer" }),
    ev("usage/recorded", { tokens: { input: 10, output: 4 }, cost: 0.002 }),
    ev("turn/stopped", { turnId: "t1", reason: "completed" }),
    ev("user/message", { text: "two" }),
  ];
  const rewound = ev("session/rewound", { atSeq: events[8]!.seq });
  const all = [...events, rewound];
  const replay = buildModel(all);
  const incremental = all.reduce(reduceEvent, emptyModel());
  assert.deepEqual(replay.messages, incremental.messages);
  assert.deepEqual(replay.turn, incremental.turn);
  assert.deepEqual(replay.totals, incremental.totals);
  assert.deepEqual(replay.rewind, incremental.rewind);
  assert.deepEqual(replay.fork, incremental.fork);
  // The rewind derives the exact prompt as the draft; the tail is hidden.
  assert.equal(replay.rewind?.draft?.text, "two");
  assert.equal(replay.messages.filter((x) => x.undone).length, 1);
});

test("a reasoning-only final record stays one disclosure and never an answer bubble", () => {
  const m = buildModel([
    ev("assistant/reasoning-chunk", { partId: "rz", text: "step " }),
    ev("assistant/message", { partId: "rz", text: "", reasoning: "step by step" }),
    ev("assistant/message", { partId: "az", text: "final answer" }),
  ]);
  const merged = mergeThinking(m.messages);
  // One merged assistant row: reasoning attached to the answer, no bare bubble.
  assert.equal(merged.length, 1);
  const only = merged[0]!;
  assert.equal(only.kind, "assistant");
  if (only.kind === "assistant") {
    assert.equal(only.text, "final answer");
    assert.equal(only.reasoning, "step by step");
  }
});

test("copy payloads: exact markdown, stable JSON with ISO+epoch time and sanitized attachments", () => {
  const events = [
    ev("user/message", {
      text: "expanded body",
      raw: "/cmd body",
      attachments: [{
        id: "att-1", name: "notes.md", mime: "text/markdown", size: 42,
        kind: "file", path: "notes.md", url: "/api/files/raw?projectId=p&path=notes.md",
      }],
    }),
    ev("assistant/chunk", { partId: "cp", text: "he" }),
    ev("assistant/message", { partId: "cp", text: "hello **world**", reasoning: "quietly" }),
  ];
  const m = buildModel(events);
  const user = m.messages[0]!;
  const asst = m.messages[1]!;
  assert.ok(user.kind === "user" && asst.kind === "assistant");
  if (user.kind !== "user" || asst.kind !== "assistant") return;

  assert.equal(copyMarkdown(user), "expanded body"); // exact projected text
  assert.equal(copyMarkdown(asst), "hello **world**");

  const uj = JSON.parse(copyJson(user)) as Record<string, unknown>;
  assert.equal(uj.role, "user");
  assert.equal(uj.text, "expanded body");
  assert.equal(uj.time, new Date(user.time).toISOString());
  assert.equal(uj.timeMs, user.time);
  assert.deepEqual(uj.attachments, [{ name: "notes.md", mime: "text/markdown", size: 42, kind: "file" }]);
  // No backend ids, urls, paths, or local provenance leave the app.
  const raw = copyJson(user);
  for (const secret of ["att-1", "url", "\"path\"", "backend", "eventSeq", "raw"]) {
    assert.equal(raw.includes(secret), false, `copy JSON must not include ${secret}`);
  }

  const aj = JSON.parse(copyJson(asst)) as Record<string, unknown>;
  assert.equal(aj.role, "assistant");
  assert.equal(aj.text, "hello **world**");
  assert.equal(aj.reasoning, "quietly");
  assert.equal(aj.time, new Date(assistantTime(asst)).toISOString());
  assert.equal(aj.timeMs, assistantTime(asst));
});

test("purpose-and-target names and one announcement per copy outcome", () => {
  assert.equal(copyActionName("user", "markdown"), "Copy user message as Markdown");
  assert.equal(copyActionName("assistant", "json"), "Copy assistant answer as JSON");
  assert.equal(copyAnnouncement("markdown"), "Message copied as Markdown");
  assert.equal(copyAnnouncement("json"), "Message copied as JSON");
  assert.equal(copyAnnouncement("reasoning"), "Reasoning copied");
  assert.equal(copyAnnouncement("failed"), "Couldn’t copy message");
  assert.equal(reasoningToggleName(false), "Show reasoning for assistant answer");
  assert.equal(reasoningToggleName(true), "Hide reasoning for assistant answer");
  assert.match(revertActionName(1_700_000_000_000), /^Revert and edit user message sent /);
  assert.match(forkActionName(1_700_000_000_000), /^Fork and edit from user message sent /);
  // Semantic time attributes: valid ISO dateTime, locale-formatted visuals.
  assert.equal(timeIso(0), "1970-01-01T00:00:00.000Z");
  assert.equal(typeof timeShort(1_700_000_000_000), "string");
});

test("timeline layout names: purpose-and-target labels for nav, jump, and turn containers", () => {
  // Fixed control names (UX-TIMELINE-LAYOUT-01 §2.3/§2.4).
  assert.equal(JUMP_TO_LATEST_NAME, "Jump to latest");
  assert.equal(OPEN_TIMELINE_NAME, "Open session timeline");
  assert.equal(PROMPT_NAV_NAME, "Prompts in this session");

  // Bounded previews: first non-empty line, truncated, honest about emptiness.
  assert.equal(boundedPromptPreview("Fix the flaky test\nplease"), "Fix the flaky test");
  assert.equal(boundedPromptPreview("\n\n  second line only  \n"), "second line only");
  assert.equal(boundedPromptPreview(""), "(empty prompt)");
  assert.equal(boundedPromptPreview("   \n \t "), "(empty prompt)");
  const long = "x".repeat(200);
  const bounded = boundedPromptPreview(long);
  assert.equal(bounded.length, 80);
  assert.ok(bounded.endsWith("…"));
  assert.equal(boundedPromptPreview(long, 10), `${"x".repeat(9)}…`);

  // Ordered, window-aware prompt jump names carry position AND target.
  assert.equal(
    promptJumpName(0, 3, "Refactor the parser"),
    "Jump to prompt 1 of 3: Refactor the parser",
  );
  assert.equal(promptJumpName(2, 3, ""), "Jump to prompt 3 of 3: (empty prompt)");

  // Turn container names: role via the accessible name, streaming is honest.
  assert.match(userArticleName(1_700_000_000_000), /^User message sent .+\d/);
  assert.match(assistantArticleName(true, 1_700_000_000_000), /^Assistant answer completed .+\d/);
  assert.equal(assistantArticleName(false, 1_700_000_000_000), "Assistant answer streaming");
});

test("session surface: unresolved replay is loading, never the fresh-session hero", () => {
  // UX-TIMELINE-LAYOUT-01 §8 initial replay (verifier finding 3): while a
  // canonical event load is in flight, an otherwise-fresh surface presents
  // as loading; a populated surface stays visible during a session switch.
  const fresh: SurfaceModel = { messages: [], permissions: [], questions: [], secrets: [] };
  const populated = {
    messages: [{ kind: "user" }],
    permissions: [],
    questions: [],
    secrets: [],
  } as unknown as SurfaceModel;
  const idle = { status: "idle" } as const;

  // Genuinely fresh states keep the hero.
  assert.equal(sessionSurfaceKind(null, null, fresh, null), "hero");
  assert.equal(sessionSurfaceKind("s1", null, fresh, idle), "hero");

  // Any in-flight open turns a would-be hero into the loading row — the boot
  // deep-link case has no active session yet, the reload case reopens its own.
  assert.equal(sessionSurfaceKind(null, "s1", fresh, null), "loading");
  assert.equal(sessionSurfaceKind("s1", "s1", fresh, idle), "loading");

  // Real content always wins: a visible session stays visible while another
  // one loads, and once messages exist the loading claim is irrelevant.
  assert.equal(sessionSurfaceKind("s1", "s2", populated, idle), "session");
  assert.equal(sessionSurfaceKind("s1", null, populated, idle), "session");

  // Archived and pending-request sessions never regress to hero or loading.
  assert.equal(sessionSurfaceKind("s1", null, fresh, { status: "archived" }), "session");
  const pendingQuestion = {
    messages: [],
    permissions: [],
    questions: [{ status: "pending" }],
    secrets: [],
  } as unknown as SurfaceModel;
  assert.equal(sessionSurfaceKind("s1", "s1", pendingQuestion, idle), "session");
  const pendingSecret = {
    messages: [],
    permissions: [],
    questions: [],
    secrets: [{ status: "pending" }],
  } as unknown as SurfaceModel;
  assert.equal(sessionSurfaceKind("s1", "s1", pendingSecret, idle), "session");
});

test("truthful guards explain exactly why revert/fork are unavailable", () => {
  const idle = { turnWorking: false, pendingRequest: false, queuedCount: 0, rewindActive: false, archived: false };
  assert.deepEqual(revertAvailability(idle), { enabled: true });
  assert.deepEqual(forkAvailability(idle), { enabled: true });
  assert.deepEqual(
    revertAvailability({ ...idle, turnWorking: true }),
    { enabled: false, reason: "Revert unavailable while a turn is running" },
  );
  assert.deepEqual(
    revertAvailability({ ...idle, pendingRequest: true }),
    { enabled: false, reason: "Revert unavailable while a request is waiting" },
  );
  assert.deepEqual(
    revertAvailability({ ...idle, queuedCount: 2 }),
    { enabled: false, reason: "Revert unavailable while messages are queued" },
  );
  assert.deepEqual(
    revertAvailability({ ...idle, rewindActive: true }),
    { enabled: false, reason: "Restore or replace the current revert first" },
  );
  // Priority: the pending request outranks the open turn it is blocking —
  // "answer the request" is the actionable reason, not the symptom.
  assert.deepEqual(
    revertAvailability({ ...idle, turnWorking: true, pendingRequest: true }),
    { enabled: false, reason: "Revert unavailable while a request is waiting" },
  );
  assert.equal(forkAvailability({ ...idle, turnWorking: true }).enabled, false);
  // guardsFromModel derives from the live render model.
  const working = buildModel([ev("turn/started", { turnId: "g1" })]);
  assert.equal(guardsFromModel(working).turnWorking, true);
  const waiting = buildModel([ev("question/asked", { requestId: "q1", questions: [] })]);
  assert.equal(guardsFromModel(waiting).pendingRequest, true);
  const waitingForSecret = buildModel([ev("secret/requested", { requestId: "s1", handle: "token", label: "Token" })]);
  assert.equal(guardsFromModel(waitingForSecret).pendingRequest, true);
});

test("marker-owned seeds apply at most once and never overwrite edits or deliberate clears", () => {
  const key = rewindSeedKey(57);
  assert.equal(shouldApplySeed(null, key), true);
  assert.equal(shouldApplySeed({ key, seedText: "orig" }, key), false);
  assert.equal(shouldApplySeed({ key: rewindSeedKey(3), seedText: "old" }, key), true);
  assert.equal(shouldApplySeed({ key: forkSeedKey("src", 42), seedText: "x" }, forkSeedKey("src", 42)), false);
  assert.notEqual(forkSeedKey("src", 42), forkSeedKey("src", 43));
  assert.equal(forkSeedKey("src"), "fork:src:all");
  // Draft states derive from the record + current text: seed → edited → cleared.
  const record = { key, seedText: "orig" };
  assert.equal(draftStateOf(null, "whatever"), "none");
  assert.equal(draftStateOf(record, "orig"), "seed");
  assert.equal(draftStateOf(record, "orig + more"), "edited");
  assert.equal(draftStateOf(record, ""), "cleared");
});

test("typed mutation errors become bounded actionable messages", () => {
  const mismatch = Object.assign(new Error("child history diverged"), { code: "history-mismatch" });
  assert.match(mutationErrorMessage("fork", mismatch), /Fork failed: the backend history/);
  assert.match(mutationErrorMessage("fork", mismatch), /Nothing was changed/);
  const conflict = Object.assign(new Error("busy"), { code: "conflict" });
  assert.match(mutationErrorMessage("revert", conflict), /isn’t available right now/);
  const unsupported = Object.assign(new Error("nope"), { code: "unsupported" });
  assert.match(mutationErrorMessage("fork", unsupported), /isn’t supported/);
  assert.match(mutationErrorMessage("restore", new Error("boom")), /Couldn’t restore: boom/);
});