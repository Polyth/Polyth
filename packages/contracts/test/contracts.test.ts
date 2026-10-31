// Contract shape round-trips. Contracts are type-only plus tiny helpers;
// these tests pin serialization compatibility for new event payloads.
import { test } from "node:test";
import assert from "node:assert/strict";

import { cap, errorBodyText, isolationBlocksUserMutation, isUiSlot, MODEL_VISIBLE_TYPES, RUNTIME_TURN_CONTENT_EVENT_TYPES, runtimeBatchAdmitsTurnContent, runtimeEventHasTurnContent, UI_SLOTS } from "@polyth/contracts";
import type {
  BrowserAction,
  DeliveryMode,
  KnowledgeAttachedData,
  PermissionRequestData,
  QueueItemDto,
  QuestionItem,
  QuotaSnapshot,
  ScheduleCadence,
  SessionProjection,
  SubagentSnapshotData,
  TaskSnapshotData,
} from "@polyth/contracts";

test("cap() carries id and version", () => {
  const key = cap<number>("polyth.test", "2");
  assert.equal(key.id, "polyth.test");
  assert.equal(key.version, "2");
  assert.equal(cap<number>("polyth.default").version, "1");
});

test("model-visible vocabulary includes package attachments", () => {
  assert.deepEqual([...MODEL_VISIBLE_TYPES], [
    "user/message",
    "assistant/message",
    "tool/call",
    "tool/result",
    "tool/error",
    "question/asked",
    "question/answered",
    "package/attached",
    "package/context",
  ]);
});

test("composer-before is a first-class validated widget slot", () => {
  assert.ok(UI_SLOTS.includes("session.composer.before"));
  assert.equal(isUiSlot("session.composer.before"), true);
  assert.ok(UI_SLOTS.includes("session.footer"));
  assert.ok(UI_SLOTS.includes("session.header.status"));
  assert.equal(isUiSlot("session.header.status"), true);
  assert.equal(isUiSlot("session.footer"), true);
  assert.ok(UI_SLOTS.includes("composer.execution"));
  assert.ok(UI_SLOTS.includes("composer.config"));
  assert.equal(isUiSlot("composer.execution"), true);
  assert.ok(UI_SLOTS.includes("modelPicker.header"));
  assert.equal(isUiSlot("modelPicker.header"), true);
  assert.equal(isUiSlot("session.composer.after"), false);
  assert.equal(isUiSlot("app.layers"), true);
});

test("new DTOs serialize/parse without loss", () => {
  const roundtrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  const queueItem: QueueItemDto = { id: "q1", sessionId: "s1", position: 0, text: "hi", delivery: "queue", createdAt: 1 };
  assert.deepEqual(roundtrip(queueItem), queueItem);

  const task: TaskSnapshotData = {
    listId: "l1", revision: 3,
    items: [{ id: "t1", text: "do", status: "active" }],
  };
  assert.deepEqual(roundtrip(task), task);

  const sub: SubagentSnapshotData = {
    revision: 1,
    agents: [{ sessionId: "s2", label: "explorer", status: "working", currentTask: "read files" }],
  };
  assert.deepEqual(roundtrip(sub), sub);

  const cadences: ScheduleCadence[] = [
    { kind: "at", at: 100 },
    { kind: "every", everyMinutes: 5 },
    { kind: "cron", expression: "0 9 * * 1-5", timeZone: "Europe/Kyiv" },
  ];
  assert.deepEqual(roundtrip(cadences), cadences);

  const quota: QuotaSnapshot = {
    providerId: "test", windows: [{ id: "w", label: "5h", used: 1, limit: 10, unit: "tokens", resetsAt: 5, periodMs: 100 }],
    fetchedAt: 1, stale: false,
  };
  assert.deepEqual(roundtrip(quota), quota);

  const knowledge: KnowledgeAttachedData = { knowledgeId: "k1", revision: 2, title: "T", body: "B", digest: "d" };
  assert.deepEqual(roundtrip(knowledge), knowledge);

  const action: BrowserAction = { kind: "click", target: { point: { x: 1, y: 2 }, frameRevision: 7 } };
  assert.deepEqual(roundtrip(action), action);
});

test("old permission/question payloads remain valid without new optional fields", () => {
  // exactly what an M1 event log contains — no preview/allowedScopes/typed questions
  const legacy = { requestId: "r1", permission: "fs/write", patterns: ["src/*"] };
  const parsed: PermissionRequestData = legacy;
  assert.equal(parsed.preview, undefined);
  assert.equal(parsed.allowedScopes, undefined);

  const q: QuestionItem = { id: "q1", prompt: "Pick one", type: "single", options: [{ value: "a", label: "A" }] };
  assert.equal(JSON.parse(JSON.stringify(q)).prompt, "Pick one");
});

test("session projection new fields are optional to old clients", () => {
  const oldShape: SessionProjection = {
    id: "s1", projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1,
  };
  assert.equal(oldShape.attention, undefined);
  assert.equal(oldShape.isolation, undefined);
  const withNew: SessionProjection = {
    ...oldShape,
    attention: { questions: 1, permissions: 0, unread: 2 },
    autoAccept: true,
    autoAcceptSetting: "on",
    labelIds: ["l1"], folderId: "f1", branch: "main", worktreeState: "ready", agentProfileId: "ap1",
    isolation: {
      kind: "git-worktree",
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreePath: "/tmp/wt",
      worktreeBranch: "polyth/isolate/abc",
      targetPath: "/tmp/repo",
      targetBranch: "main",
      originPath: "/tmp/repo",
      baseCommit: "abc123",
    },
  };
  const parsed = JSON.parse(JSON.stringify(withNew)) as SessionProjection;
  assert.equal(parsed.attention?.questions, 1);
  assert.equal(parsed.autoAccept, true);
  assert.equal(parsed.autoAcceptSetting, "on");
  assert.equal(parsed.isolation?.kind, "git-worktree");
  assert.equal(parsed.isolation?.targetBranch, "main");
  const deliveries: DeliveryMode[] = ["normal", "steer", "queue", "interrupt"];
  assert.equal(deliveries.length, 4);
});

test("isolationBlocksUserMutation covers runtime epoch and wait states", () => {
  assert.equal(isolationBlocksUserMutation("idle"), false);
  assert.equal(isolationBlocksUserMutation("failed"), false);
  assert.equal(isolationBlocksUserMutation("finished"), false);
  assert.equal(isolationBlocksUserMutation("unknown"), true);
  assert.equal(isolationBlocksUserMutation("working"), true);
  assert.equal(isolationBlocksUserMutation("waiting"), true);
  assert.equal(isolationBlocksUserMutation("reconciling"), true);
  assert.equal(isolationBlocksUserMutation("epoch-pending"), true);
  assert.equal(isolationBlocksUserMutation("archived"), true);
});

test("errorBodyText never lets a gateway HTML page reach an error surface", () => {
  const page = "<html>\n<head><title>504 Gateway Time-out</title></head>\n<body><center><h1>504 Gateway Time-out</h1></center></body></html>";
  assert.equal(errorBodyText(page), "504 Gateway Time-out");
  assert.equal(errorBodyText("<html><body>Bad gateway</body></html>"), "Bad gateway");
  assert.equal(errorBodyText("<html><head><style>body{color:red}</style></head><body>Upstream failed</body></html>"), "Upstream failed");
  // A title-less page still must not leak tags.
  assert.ok(!errorBodyText("<html><body><h1>503</h1><p>Service Unavailable</p></body></html>").includes("<"));
  assert.equal(errorBodyText("<html><head><title></title></head><body></body></html>"), "");
});

test("errorBodyText preserves plain text, including newlines and entities", () => {
  const plain = "Antigravity couldn’t start\nCannot replace exact native history";
  assert.equal(errorBodyText(plain), plain);
  assert.equal(errorBodyText("unexpected token <"), "unexpected token <");
  assert.equal(errorBodyText("A & B"), "A & B");
  assert.equal(errorBodyText("   "), "");
});

test("errorBodyText bounds long visible text", () => {
  const bounded = errorBodyText(`<html><body>${"x".repeat(400)}</body></html>`);
  assert.ok(bounded.length <= 200);
  assert.ok(bounded.endsWith("…"));
});

// Turn admission is a cross-boundary rule: the session service fences ingestion
// and adapters refuse to report, so both sides must agree on what counts as
// turn content and when a runtime batch may become canonical history.
test("turn content and runtime batch admission", () => {
  assert.deepEqual(RUNTIME_TURN_CONTENT_EVENT_TYPES, [
    "assistant/chunk",
    "assistant/reasoning-chunk",
    "assistant/message",
    "tool/call",
    "tool/started",
    "tool/result",
    "tool/error",
    "usage/recorded",
    "turn/stopped",
  ]);
  assert.equal(runtimeEventHasTurnContent("assistant/chunk"), true);
  assert.equal(runtimeEventHasTurnContent("turn/stopped"), true);
  // A request is answerable even without a visible turn: dropping it would
  // strand the tool call waiting for a reply nobody asked for.
  assert.equal(runtimeEventHasTurnContent("permission/requested"), false);
  assert.equal(runtimeEventHasTurnContent("question/asked"), false);
  assert.equal(runtimeEventHasTurnContent("turn/started"), false);
  assert.equal(runtimeEventHasTurnContent("runtime/commands-changed"), false);
  assert.equal(runtimeEventHasTurnContent("context/updated"), false);

  // A live turn admits everything; a batch carrying its own marker admits the
  // content that travels with it; neither means the work was never admitted.
  assert.equal(runtimeBatchAdmitsTurnContent([{ type: "assistant/chunk" }], true), true);
  assert.equal(runtimeBatchAdmitsTurnContent([{ type: "assistant/chunk" }, { type: "turn/started" }], false), true);
  assert.equal(runtimeBatchAdmitsTurnContent([{ type: "assistant/chunk" }], false), false);
  // Bookkeeping no turn owns is never gated by turn admission.
  assert.equal(runtimeEventHasTurnContent("runtime/commands-changed"), false);
  assert.equal(runtimeBatchAdmitsTurnContent([{ type: "runtime/commands-changed" }], false), false);
});
