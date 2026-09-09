import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIsolation, transitionIsolation, isolationActions, isManagedIsolationBranch,
  type SessionIsolation, type IsolationPublishIntent, type IsolationLifecycle } from "../src/index.ts";

const active: SessionIsolation = { kind: "git-worktree", state: "active", createdAt: "2026-09-08", worktreePath: "/repo-isolate/abc",
  worktreeBranch: "polyth/isolate/abc", targetPath: "/repo", targetBranch: "main", originPath: "/repo", baseCommit: "base" };
const resultCommit = "b".repeat(40);
const intent: IsolationPublishIntent = {
  expectedTargetSha: "a".repeat(40),
  resultCommit,
  snapshotSha: "c".repeat(40),
  targetRef: "refs/heads/main",
};
const raw = (fields: object) => ({ ...active, ...fields }) as SessionIsolation;

test("legacy publication and cleanup phases normalize without losing recovery identity", () => {
  const publishing = normalizeIsolation(raw({ state: "merging", publish: intent, conflict: { message: "old", files: [] } }));
  assert.equal(publishing.state, "publishing");
  assert.deepEqual(publishing.publish, intent);
  assert.equal(publishing.conflict, undefined);
  const pending = normalizeIsolation(raw({ state: "cleanup-pending", resultCommit, rebound: false }));
  assert.equal(pending.state, "rebind-pending");
  assert.equal(pending.resultCommit, resultCommit);
  const cleanup = normalizeIsolation(raw({ state: "cleanup-pending", resultCommit, rebound: true }));
  assert.equal(cleanup.state, "cleanup-pending");
  assert.equal(cleanup.rebound, true);
  assert.deepEqual(normalizeIsolation(publishing), publishing);
  assert.deepEqual(normalizeIsolation(pending), pending);
});

test("legacy pre-publication merging normalizes to active", () => {
  assert.equal(normalizeIsolation(raw({ state: "merging" })).state, "active");
});

test("unknown or impossible durable states fail closed without modifying the input", () => {
  for (const fields of [
    { state: "future" }, { state: "active", publish: intent }, { state: "active", rebound: true },
    { state: "active", resultCommit }, { state: "active", dismissedRevision: 42 },
    { state: "publishing" }, { state: "conflict", conflict: { message: "oops", files: [1] } },
    { state: "conflict", conflict: { message: "oops", files: [] }, resultCommit },
    { state: "publishing", publish: { ...intent, receiptRef: 123 } },
    { state: "publishing", publish: { ...intent, receiptRef: "refs/polyth/x" } },
    { state: "publishing", publish: {
      ...intent, receiptRef: "refs/heads/main", checkoutPath: "/repo", sourceRevision: "revision",
    } },
    { state: "rebind-pending", sourceRevision: 42 }, { state: "rebind-pending", rebound: true },
    { state: "merging", resultCommit }, { state: "active", sourceSessionId: 42 },
  ]) {
    const value = raw(fields);
    const before = JSON.stringify(value);
    assert.equal(normalizeIsolation(value).state, "corrupt");
    assert.equal(JSON.stringify(value), before);
  }
});

test("transitions clear phase-specific payloads and preserve immutable origin", () => {
  const publishing = transitionIsolation(active, { state: "publishing", publish: intent });
  const rebound = transitionIsolation(publishing, { state: "rebind-pending", resultCommit, sourceRevision: "revision" });
  const cleanup = transitionIsolation(rebound, { state: "cleanup-pending", resultCommit, rebound: true, sourceRevision: "revision" });
  assert.equal(rebound.publish, undefined);
  assert.equal(cleanup.originPath, active.originPath);
  assert.equal(cleanup.worktreePath, active.worktreePath);
  assert.equal(cleanup.sourceRevision, "revision");
});

test("state action policy forbids unavailable, busy and pending mutations", () => {
  for (const state of ["missing", "unowned", "corrupt", "publishing", "rebind-pending", "cleanup-pending"] as const) {
    const status = { isolation: active, suggestion: null, effectiveState: state };
    const actions = isolationActions(status, "idle");
    assert.equal(actions.canMerge, false);
    assert.equal(actions.canKeep, false);
    assert.equal(actions.canResolve, false);
    assert.equal(actions.canDiscard, state === "missing");
    assert.equal(actions.needsRecovery, true);
    assert.equal(isolationActions(status, "working").needsRecovery, false);
  }
  for (const sessionStatus of ["working", "unknown", "waiting", "epoch-pending", "reconciling", "archived"] as const) {
    const actions = isolationActions({ isolation: active, suggestion: { eligible: true, hasChanges: true, targetDirty: false, targetBranch: "main", revision: "r" } }, sessionStatus);
    assert.equal(actions.canMerge || actions.canKeep || actions.canDiscard, false);
  }
  const unavailable = isolationActions({ isolation: active, suggestion: { eligible: false, hasChanges: true, targetDirty: false, targetBranch: "main", revision: "r", reason: "destination-unavailable" } }, "idle");
  assert.equal(unavailable.canMerge || unavailable.canDiscard, false);
  assert.equal(unavailable.canKeep, true);
});

test("managed origin filter recognizes full refs and leaves normal user branches", () => {
  assert.equal(isManagedIsolationBranch("refs/heads/polyth/isolate/abc"), true);
  assert.equal(isManagedIsolationBranch("polyth/isolate/abc"), true);
  assert.equal(isManagedIsolationBranch("polyth/integrate/abc"), true);
  assert.equal(isManagedIsolationBranch("feature/isolate"), false);
});

// Compile-time release gates: invalid phase tuples cannot be authored.
// @ts-expect-error publishing requires a durable intent
const missingIntent: IsolationLifecycle = { state: "publishing" };
// @ts-expect-error cleanup requires completed runtime rebind
const prematureCleanup: IsolationLifecycle = { state: "cleanup-pending", rebound: false };
// @ts-expect-error active cannot retain an irreversible publication
const activePublication: IsolationLifecycle = { state: "active", publish: intent };
void [missingIntent, prematureCleanup, activePublication];
