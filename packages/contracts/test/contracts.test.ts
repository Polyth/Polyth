// WP1: contract shape round-trips. Contracts are type-only plus tiny helpers;
// these tests pin serialization compatibility for new event payloads.
import { test } from "node:test";
import assert from "node:assert/strict";

import { cap, MODEL_VISIBLE_TYPES } from "@polyth/contracts";
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

test("model-visible vocabulary is unchanged (replay compatibility)", () => {
  assert.deepEqual([...MODEL_VISIBLE_TYPES], [
    "user/message",
    "assistant/message",
    "tool/call",
    "tool/result",
    "tool/error",
    "question/asked",
    "question/answered",
  ]);
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
  const withNew: SessionProjection = {
    ...oldShape,
    attention: { questions: 1, permissions: 0, unread: 2 },
    labelIds: ["l1"], folderId: "f1", branch: "main", worktreeState: "ready", agentProfileId: "ap1",
  };
  const parsed = JSON.parse(JSON.stringify(withNew)) as SessionProjection;
  assert.equal(parsed.attention?.questions, 1);
  const deliveries: DeliveryMode[] = ["normal", "steer", "queue", "interrupt"];
  assert.equal(deliveries.length, 4);
});
