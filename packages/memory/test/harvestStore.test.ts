import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemoryStore, type MemoryScope } from "../../knowledge/src/memory.ts";

const scope: MemoryScope = { spaceId: "space-a", projectId: "project-a", principalId: "principal-a" };
const job = (generation: string, key: string) => ({
  jobKey: key,
  spaceId: scope.spaceId,
  projectId: scope.projectId,
  sessionId: "session-a",
  sourceStartSeq: 10,
  sourceEndSeq: 20,
  sourceDigest: "source-digest-1",
  policyGeneration: generation,
  extractorVersion: "memory-harvest-v1",
});

test("harvest lease expiry is durable across reopen and resumes from the checkpoint range", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-harvest-restart-"));
  const file = join(dir, "knowledge.db");
  const first = new DatabaseSync(file);
  const store = createMemoryStore(first, scope.spaceId, () => 100);
  const generation = store.getPolicy(scope).generation;
  store.enqueueHarvest(scope, job(generation, "session-a:10-20"));
  assert.equal(store.claimHarvest(scope, "worker-a", 10, 100)?.attempts, 1);
  first.close();

  const reopened = new DatabaseSync(file);
  const recovered = createMemoryStore(reopened, scope.spaceId, () => 120);
  const leased = recovered.claimHarvest(scope, "worker-b", 30, 120);
  assert.equal(leased?.jobKey, "session-a:10-20");
  assert.equal(leased?.sourceStartSeq, 10);
  assert.equal(leased?.sourceEndSeq, 20);
  assert.equal(leased?.attempts, 2);
  assert.equal(recovered.completeHarvest(scope, leased!.jobKey, "worker-b", "receipt-1", "checkpoint-1"), true);
  assert.equal(recovered.claimHarvest(scope, "worker-c", 30, 121), undefined);
  reopened.close();
});

test("claim walks only live jobs through the claimable index, oldest range first", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId, () => 100);
  const generation = store.getPolicy(scope).generation;
  for (let i = 0; i < 50; i++) store.enqueueHarvest(scope, { ...job(generation, `denied-${i}`), sourceStartSeq: i, sourceEndSeq: i });
  db.prepare("UPDATE memory_harvest_jobs SET status='denied'").run();
  store.enqueueHarvest(scope, { ...job(generation, "later"), sourceStartSeq: 90, sourceEndSeq: 95 });
  store.enqueueHarvest(scope, { ...job(generation, "earlier"), sourceStartSeq: 60, sourceEndSeq: 70 });
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM memory_harvest_jobs WHERE space_id=? AND project_id=? AND status IN ('pending','leased') AND (status='pending' OR (status='leased' AND lease_expires_at <= ?)) AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY source_end_seq LIMIT 1`)
    .all(scope.spaceId, scope.projectId, 100, 100).map((row) => String((row as { detail: string }).detail)).join("\n");
  assert.match(plan, /idx_memory_jobs_claimable/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  assert.equal(store.claimHarvest(scope, "worker-a", 10, 100)?.jobKey, "earlier");
  assert.equal(store.claimHarvest(scope, "worker-a", 10, 100)?.jobKey, "later");
  // An expired lease is claimable again; terminal rows never are.
  assert.equal(store.claimHarvest(scope, "worker-b", 10, 111)?.jobKey, "earlier");
  db.close();
});

test("clear fences pending harvest jobs and off recall blocks without inference", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const policy = store.getPolicy(scope);
  store.enqueueHarvest(scope, job(policy.generation, "session-a:1-2"));
  const cleared = store.clear(scope, policy.generation);
  assert.notEqual(cleared.generation, policy.generation);
  assert.equal(store.claimHarvest(scope, "worker-a"), undefined);
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "durable decision" }).status, "blocked");
  db.close();
});

test("harvest commit atomically writes records, receipt, cursor, and generation fence", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const policy = store.getPolicy(scope);
  store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto" } });
  const active = store.getPolicy(scope);
  store.enqueueHarvest(scope, job(active.generation, "session-a:10-20"));
  assert.equal(store.claimHarvest(scope, "worker-a")?.jobKey, "session-a:10-20");
  const committed = store.commitHarvest(scope, "session-a:10-20", "worker-a", active.generation, [{
    title: "Durable decision", body: "Commit with the checkpoint", lifecycle: "candidate", evidence: "source-observed",
    sources: [{ kind: "session", sessionId: "session-a", startSeq: 10, endSeq: 20 }], idempotencyKey: "harvest-item-1", requestFingerprint: "fingerprint-1",
  }], "receipt-1", "checkpoint-1", 21);
  assert.deepEqual(committed, { committed: 1, duplicates: 0 });
  assert.equal(store.harvestCursor(scope, "session-a")?.nextSeq, 21);
  assert.equal(store.claimHarvest(scope, "worker-b"), undefined);
  db.close();
});

test("generation change during a leased harvest rolls back the whole batch", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const seed = store.create(scope, { projectId: scope.projectId, title: "Existing", body: "Keep this", lifecycle: "active", evidence: "user-stated" });
  const policy = store.getPolicy(scope);
  store.enqueueHarvest(scope, job(policy.generation, "session-a:30-40"));
  assert.ok(store.claimHarvest(scope, "worker-a"));
  store.forget(scope, { id: seed.memoryId!, projectId: scope.projectId, expectedRevision: 1 });
  assert.throws(() => store.commitHarvest(scope, "session-a:30-40", "worker-a", policy.generation, [{
    title: "Must not resurrect", body: "Old source", lifecycle: "candidate", evidence: "source-observed",
    idempotencyKey: "harvest-item-2", requestFingerprint: "fingerprint-2",
  }], "receipt-2", "checkpoint-2", 41), /generation changed|lease is no longer active/);
  assert.equal(store.list(scope, { lifecycle: "candidate" }).total, 0);
  db.close();
});

test("manual lock survives agent update attempts and foreign Space scope is denied", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const created = store.create(scope, {
    projectId: scope.projectId,
    title: "Manual decision",
    body: "Use the canonical store",
    lifecycle: "active",
    evidence: "user-stated",
    userLocked: true,
  });
  assert.throws(() => store.update(scope, {
    id: created.memoryId!, projectId: scope.projectId, expectedRevision: 1, patch: { body: "overwritten" },
  }, "agent"), /locked/);
  const foreign: MemoryScope = { ...scope, spaceId: "space-b", principalId: "principal-b" };
  assert.throws(() => store.get(foreign, created.memoryId!), /Space scope is invalid/);
  db.close();
});

test("forgotten source is omitted from bounded recall after the forget receipt", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const created = store.create(scope, {
    projectId: scope.projectId,
    title: "Old source",
    body: "This must stop being delivered",
    lifecycle: "active",
    evidence: "source-observed",
    sources: [{ kind: "session", sessionId: "session-a", startSeq: 10, endSeq: 20 }],
  });
  assert.equal(store.forget(scope, { id: created.memoryId!, projectId: scope.projectId, expectedRevision: 1 }).status, "committed");
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "stop being delivered" }).selected.length, 0);
  db.close();
});

test("recall honors an explicit zero budget without invoking any model path", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const policy = store.getPolicy(scope);
  store.updatePolicy(scope, {
    projectId: scope.projectId,
    expectedSettingsRevision: policy.settingsRevision,
    patch: { mode: "auto", contextBudget: { maxRecords: 0, maxBytes: 0 } },
  });
  const contribution = store.recall(scope, { projectId: scope.projectId, intent: "anything" });
  assert.equal(contribution.status, "empty");
  assert.equal(contribution.selected.length, 0);
  db.close();
});

test("utility call budget reserves durably and never refunds an unknown outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-utility-budget-"));
  const file = join(dir, "knowledge.db");
  const first = new DatabaseSync(file);
  const store = createMemoryStore(first, scope.spaceId);
  const policy = store.getPolicy(scope);
  store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { utilityBudget: { maxCalls: 2 } } });
  const firstReservation = store.reserveUtilityCall(scope, 600);
  const secondReservation = store.reserveUtilityCall(scope, 600);
  assert.equal(store.getPolicy(scope).utilityBudget.remainingCalls, 0);
  assert.throws(() => store.reserveUtilityCall(scope, 600), /budget exhausted/);
  store.reconcileUtilityCall(scope, firstReservation.reservationId, "consumed");
  store.reconcileUtilityCall(scope, secondReservation.reservationId, "consumed");
  first.close();
  const reopened = new DatabaseSync(file);
  const recovered = createMemoryStore(reopened, scope.spaceId);
  assert.equal(recovered.getPolicy(scope).utilityBudget.usedCalls, 2);
  assert.throws(() => recovered.reserveUtilityCall(scope, 600), /budget exhausted/);
  reopened.close();
});

test("harvest attempts stop after bounded retries and terminal failures stay visible", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const generation = store.getPolicy(scope).generation;
  store.enqueueHarvest(scope, job(generation, "session-a:50-60"));
  for (let attempt = 0; attempt < 3; attempt++) {
    const leased = store.claimHarvest(scope, `worker-${attempt}`, 30_000);
    assert.ok(leased);
    store.failHarvest(scope, leased!.jobKey, `worker-${attempt}`, "provider-failed", 0, "pending");
  }
  assert.equal(store.claimHarvest(scope, "worker-final"), undefined);
  db.close();
});

test("remember-off ranges are durably skipped and cannot reharvest after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-skip-restart-"));
  const file = join(dir, "knowledge.db");
  const first = new DatabaseSync(file);
  const store = createMemoryStore(first, scope.spaceId);
  const generation = store.getPolicy(scope).generation;
  store.enqueueHarvest(scope, { ...job(generation, "session-a:70-75:excluded"), sourceDigest: "remember-off", extractorVersion: "memory-harvest-v1-excluded" });
  assert.ok(store.claimHarvest(scope, "worker-a"));
  assert.equal(store.skipHarvest(scope, "session-a:70-75:excluded", "worker-a", generation, "remember-off", 76), true);
  assert.equal(store.harvestCursor(scope, "session-a")?.nextSeq, 76);
  first.close();
  const reopened = new DatabaseSync(file);
  const recovered = createMemoryStore(reopened, scope.spaceId);
  assert.equal(recovered.claimHarvest(scope, "worker-b"), undefined);
  assert.equal(recovered.harvestCursor(scope, "session-a")?.nextSeq, 76);
  reopened.close();
});
