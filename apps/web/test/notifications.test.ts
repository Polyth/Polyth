import { test } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_NOTIFY_TEMPLATE, diffNotifications, redactNotifyText, renderTemplate,
  type NotifyKind, type SessionSnapshot,
} from "../src/notifications.ts";

const snap = (over: Partial<SessionSnapshot> & { id: string }): SessionSnapshot => ({
  projectId: "p1", title: `Session ${over.id}`, status: "idle", ...over,
});

const kinds = (...k: NotifyKind[]): Set<NotifyKind> => new Set(k);

const asMap = (list: SessionSnapshot[]): Map<string, SessionSnapshot> =>
  new Map(list.map((s) => [s.id, s]));

test("template: allowlisted vars substitute, unknown vars stay literal", () => {
  const out = renderTemplate("{session} — {status} {nope} {constructor}", {
    session: "My chat", status: "finished",
  });
  assert.equal(out, "My chat — finished {nope} {constructor}");
});

test("template: values are capped, control chars stripped, output bounded", () => {
  const out = renderTemplate("{preview}", { preview: `a\u0007b${"x".repeat(300)}` });
  assert.ok(out.startsWith("a b"));
  assert.ok(out.length <= 201);
  assert.ok(!out.includes("\u0007"));
});

test("template: secrets in values are redacted", () => {
  const out = renderTemplate("{preview}", { preview: "key sk_live_abcdef123456789012 done" });
  assert.ok(!out.includes("sk_live_abcdef123456789012"));
  assert.ok(out.includes("[redacted]"));
});

test("redactNotifyText masks bearer tokens and api keys", () => {
  assert.ok(!redactNotifyText("Authorization: Bearer abc123def456ghi").includes("abc123def456ghi"));
  assert.ok(!redactNotifyText("api_key=super-secret-1").includes("super-secret-1"));
});

test("working → idle emits completed; failed maps to failed kind", () => {
  const prev = asMap([snap({ id: "a", status: "working" }), snap({ id: "b", status: "working" })]);
  const next = [snap({ id: "a", status: "idle" }), snap({ id: "b", status: "failed" })];
  const specs = diffNotifications(prev, next, { kinds: kinds("completed", "failed") });
  assert.deepEqual(specs.map((s) => s.kind), ["completed", "failed"]);
  assert.equal(specs[0]!.body, "Session a — finished");
  assert.equal(specs[1]!.body, "Session b — failed");
});

test("kind filter: disabled kinds emit nothing", () => {
  const prev = asMap([snap({ id: "a", status: "working" })]);
  const next = [snap({ id: "a", status: "failed" })];
  assert.deepEqual(diffNotifications(prev, next, { kinds: kinds("completed") }), []);
});

test("first sight primes silently — replay produces no notifications", () => {
  const specs = diffNotifications(new Map(), [snap({ id: "a", status: "idle" })], {
    kinds: kinds("completed", "failed", "question", "permission"),
  });
  assert.deepEqual(specs, []);
});

test("subagent completion is attributed to the parent session", () => {
  const parent = snap({ id: "parent", status: "working", title: "Main task" });
  const child = snap({ id: "child", status: "working", parentId: "parent", title: "Research helper" });
  const prev = asMap([parent, child]);
  const next = [parent, { ...child, status: "idle" }];
  const specs = diffNotifications(prev, next, { kinds: kinds("subagent", "completed") });
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.kind, "subagent");
  assert.equal(specs[0]!.sessionId, "parent"); // click routes to the parent
  assert.equal(specs[0]!.title, "Main task");
  // a completed-kind duplicate is NOT also emitted for the child
  assert.ok(!specs.some((s) => s.kind === "completed"));
});

test("subagent kind disabled: delegated completions stay quiet", () => {
  const child = snap({ id: "child", status: "working", parentId: "parent" });
  const specs = diffNotifications(asMap([child]), [{ ...child, status: "idle" }], {
    kinds: kinds("completed", "failed"),
  });
  assert.deepEqual(specs, []);
});

test("attention increases emit question/permission with count-stable keys", () => {
  const before = snap({ id: "a", status: "working", attention: { questions: 0, permissions: 1 } });
  const after = snap({ id: "a", status: "working", attention: { questions: 1, permissions: 2 } });
  const specs = diffNotifications(asMap([before]), [after], { kinds: kinds("question", "permission") });
  assert.deepEqual(specs.map((s) => s.kind), ["question", "permission"]);
  assert.equal(specs[0]!.key, "a:question:1");
  assert.equal(specs[1]!.key, "a:permission:2");
  // resolved (count decreases) is silent
  const resolved = snap({ id: "a", status: "working", attention: { questions: 0, permissions: 0 } });
  assert.deepEqual(diffNotifications(asMap([after]), [resolved], { kinds: kinds("question", "permission") }), []);
});

test("stable keys make duplicate replays deduplicable", () => {
  const prev = asMap([snap({ id: "a", status: "working" })]);
  const next = [snap({ id: "a", status: "idle" })];
  const run1 = diffNotifications(prev, next, { kinds: kinds("completed") });
  const run2 = diffNotifications(prev, next, { kinds: kinds("completed") });
  assert.equal(run1[0]!.key, run2[0]!.key);
});

test("project names resolve into the {project} variable", () => {
  const prev = asMap([snap({ id: "a", status: "working" })]);
  const next = [snap({ id: "a", status: "idle" })];
  const specs = diffNotifications(prev, next, {
    kinds: kinds("completed"),
    template: "{project}: {session} {status}",
    projectNames: new Map([["p1", "Acme Site"]]),
  });
  assert.equal(specs[0]!.body, "Acme Site: Session a finished");
});

test("default template exists and renders", () => {
  assert.ok(DEFAULT_NOTIFY_TEMPLATE.includes("{session}"));
  const out = renderTemplate(DEFAULT_NOTIFY_TEMPLATE, { session: "S", status: "finished" });
  assert.equal(out, "S — finished");
});
