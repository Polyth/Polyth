import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import {
  archivedSessionRetentionSummary,
  isPristineSessionLog,
  sessionRetentionSummary,
} from "@polyth/session";

const DAY = 24 * 60 * 60_000;
const session = (id: string, status: SessionProjection["status"], updatedAt: number): SessionProjection => ({
  id,
  projectId: "p",
  title: id,
  status,
  createdAt: updatedAt,
  updatedAt,
});

test("retention includes only inactive unarchived sessions older than cutoff", () => {
  const now = 100 * DAY;
  const result = sessionRetentionSummary([
    session("old-idle", "idle", now - 31 * DAY),
    session("recent", "finished", now - 2 * DAY),
    session("working", "working", now - 90 * DAY),
    session("waiting", "waiting", now - 90 * DAY),
    session("archived", "archived", now - 90 * DAY),
  ], 30, now);

  assert.equal(result.days, 30);
  assert.deepEqual(result.eligible.map((item) => item.id), ["old-idle"]);
});

test("retention skips sessions someone still expects to come back to", () => {
  const now = 100 * DAY;
  const old = now - 90 * DAY;
  const rows: SessionProjection[] = [
    session("plain", "idle", old),
    { ...session("pinned", "idle", old), pinned: { position: 0 } },
    { ...session("draft", "idle", old), draft: "half a thought" },
    { ...session("draft-preview", "idle", old), draftPreview: "half a thought" },
    { ...session("blank-draft", "idle", old), draft: "   " },
    { ...session("resume", "failed", old), resume: { resumeAt: now + DAY } as SessionProjection["resume"] },
    { ...session("paused", "idle", old), paused: { at: old } as SessionProjection["paused"] },
    { ...session("asking", "idle", old), attention: { questions: 1, permissions: 0, unread: 0 } },
    { ...session("approving", "idle", old), attention: { questions: 0, permissions: 2, unread: 0 } },
    { ...session("unread", "idle", old), attention: { questions: 0, permissions: 0, unread: 3 } },
    { ...session("workflow", "idle", old), backgroundWork: { workflow: 1 } },
    { ...session("finished-workflow", "idle", old), backgroundWork: { workflow: 0 } },
    { ...session("agent-thread", "idle", old), purpose: "agent" },
    session("kept-by-person", "idle", old),
  ];
  const { eligible } = sessionRetentionSummary(rows, 30, now, new Set(["kept-by-person"]));
  assert.deepEqual(eligible.map((item) => item.id), ["plain", "blank-draft", "unread", "finished-workflow"]);
});

test("a delegation tree expires whole", () => {
  const now = 100 * DAY;
  const old = now - 90 * DAY;
  const fresh = now - DAY;
  const child = (id: string, parentId: string, status: SessionProjection["status"], updatedAt: number): SessionProjection =>
    ({ ...session(id, status, updatedAt), parentId });
  const { eligible } = sessionRetentionSummary([
    // Everything old: the whole tree goes.
    session("done", "idle", old),
    child("done-child", "done", "idle", old),
    child("done-grandchild", "done-child", "idle", old),
    // An old parent cannot leave with a running child, nor the child's sibling.
    session("parent-of-running", "idle", old),
    child("running", "parent-of-running", "working", old),
    child("sibling", "parent-of-running", "idle", old),
    // A recent grandchild holds the tree above it.
    session("parent-of-recent", "idle", old),
    child("middle", "parent-of-recent", "idle", old),
    child("recent", "middle", "idle", fresh),
    // A recent parent holds its old child.
    session("recent-parent", "idle", fresh),
    child("old-child", "recent-parent", "idle", old),
    // Already archived members hold nothing back and are not counted again.
    session("archived-root", "archived", fresh),
    child("left-behind", "archived-root", "idle", old),
    // A package's tree follows the package, whatever its members look like.
    { ...session("package-root", "idle", old), purpose: "workflow" },
    child("package-unit", "package-root", "idle", old),
    // A package-owned helper inside an ordinary tree goes with that tree.
    session("with-helper", "idle", old),
    { ...child("helper", "with-helper", "idle", old), purpose: "review" },
    // A parent outside the list, or a corrupt cycle, ends the walk.
    child("orphan", "gone", "idle", old),
    child("cycle-a", "cycle-b", "idle", old),
    child("cycle-b", "cycle-a", "idle", old),
  ], 30, now);
  assert.deepEqual(eligible.map((item) => item.id), [
    "done", "done-child", "done-grandchild", "left-behind", "with-helper", "helper", "orphan", "cycle-a", "cycle-b",
  ]);
});

test("archived retention includes only old archived sessions", () => {
  const now = 100 * DAY;
  const result = archivedSessionRetentionSummary([
    session("old-archive", "archived", now - 31 * DAY),
    session("recent-archive", "archived", now - 2 * DAY),
    session("old-idle", "idle", now - 90 * DAY),
  ], 30, now);

  assert.deepEqual(result.eligible.map((item) => item.id), ["old-archive"]);
});

const event = (type: string, data: Record<string, unknown> = {}): Pick<SessionEvent, "type" | "data"> =>
  ({ type, data }) as Pick<SessionEvent, "type" | "data">;

test("pristine logs contain only the create/reconcile lifecycle", () => {
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("mutation/prepared", { mutationKind: "session-create" }),
    event("mutation/confirmed", { mutationKind: "session-create" }),
    event("reconciliation/started"),
    event("runtime/status-observed", { state: "idle" }),
    event("reconciliation/completed"),
  ]), true);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("mutation/rejected", { mutationKind: "session-create" }),
  ]), true);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("mutation/uncertainty-recorded", { mutationKind: "session-create" }),
  ]), true);
});

test("pristine check is fail-closed for turns, activity, and unknown events", () => {
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("user/message"),
  ]), false);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("mutation/confirmed", { mutationKind: "turn-submit" }),
  ]), false);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("browser/action-requested"),
  ]), false);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("queue/enqueued"),
  ]), false);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("future/unknown-event"),
  ]), false);
  assert.equal(isPristineSessionLog([]), false);
  assert.equal(isPristineSessionLog([event("reconciliation/completed")]), false);
});
